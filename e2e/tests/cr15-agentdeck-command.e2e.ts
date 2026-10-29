// CR15（TC-61 的命令行部分）：AgentDeck 开的 Shell 里有 agentdeck 命令：help 能用，notify 在白板上出提示，集群外的 crew 命令
// 打 “Not in a crew.”，把 AGENTDECK_TERM 改成别的终端打 “Unauthorized”。后台：窗格环境里有这个终端自己的钥匙
// （HMAC(mcp-token, 终端 id)），PATH 最前面是 <数据目录>/bin；系统自己的终端（同一个 HOME、PATH 的登录 shell）里没有这个命令。
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeRe } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal } from '../support/flows.ts';

test('TC-61 (CR15) agentdeck in an AgentDeck shell: help, notify shows a toast, crew refused; the system’s own shell has no such command', async ({
  deck,
  sb,
}) => {
  // 沙盒的 .bash_profile 把 PATH 整个重设（export PATH='…'），这样 Shell 的 bash -l 会把 AgentDeck 加在前面的目录丢掉。
  // 用户的配置一般是往前加（PATH="…:$PATH"），这里照那样写；整个重设的情况见 tools/agentdeck-cli/AGENTS.md「已知限制」
  const profile = join(sb.home, '.bash_profile');
  writeFileSync(profile, readFileSync(profile, 'utf8').replace(/^export PATH=(.*)$/m, 'export PATH=$1:"$PATH"'));

  await deck.launch();
  const { page } = deck;
  const shell = await openTerminal(deck, null, 'shell');
  await deck.waitForPane(shell.terminalId, /e2e\$ *$/m);
  // agent 跑命令不经过白板的键盘：用 tmux send-keys 打进去（白板上 2 秒内按过键时 notify 只闪不弹提示）
  const run = (line: string) => {
    sb.tmux(['send-keys', '-t', `=${shell.terminalId}:`, '-l', line]);
    sb.tmux(['send-keys', '-t', `=${shell.terminalId}:`, 'Enter']);
  };

  // 后台：钥匙和 PATH 只在这个窗格的环境里
  const token = readFileSync(join(sb.dataDir, 'run', 'mcp-token'), 'utf8').trim();
  const env = sb.tmux(['show-environment', '-t', `=${shell.terminalId}`]).stdout;
  expect(env).toContain(`AGENTDECK_TERM_KEY=${createHmac('sha256', token).update(shell.terminalId).digest('hex')}`);
  expect(env).toMatch(new RegExp(`^PATH=${escapeRe(join(sb.dataDir, 'bin'))}:`, 'm'));
  expect(env).not.toContain(token);

  // 1. agentdeck help（真的键盘）
  await deck.focusWindow(shell.windowId);
  await deck.typeLine('agentdeck help | head -3');
  await deck.waitForPane(shell.terminalId, /"ok": true/);
  await deck.screenshot('help');

  // 2. agentdeck notify "hi"：白板上出提示
  await page.waitForTimeout(2100);
  run('agentdeck notify "hi from the shell"');
  await expect(page.getByText(/: hi from the shell$/)).toBeVisible({ timeout: 15_000 });
  await deck.screenshot('notify-toast');

  // 3. 集群外跑 crew 命令；4. 冒充别的终端
  // CrewService（CR2）组装之前主进程回 “crew is not available yet”，之后集群外是 “Not in a crew.”（TC-61 第 2 步）
  run('agentdeck crew plan; echo "exit=$?"');
  await deck.waitForPane(shell.terminalId, /^(Not in a crew\.|crew is not available yet)$[\s\S]*exit=1/m);
  run('AGENTDECK_TERM=t-000000000000 agentdeck crew status; echo "exit=$?"');
  await deck.waitForPane(shell.terminalId, /^Unauthorized$[\s\S]*exit=1/m);

  // 5. 系统自己的终端：同一个 HOME 和登录配置，PATH 里没有 agentdeck
  const system = spawnSync('/bin/bash', ['-lc', 'command -v agentdeck'], { env: { HOME: sb.home, PATH: sb.path }, encoding: 'utf8' });
  expect(system.status).not.toBe(0);
  expect(system.stdout.trim()).toBe('');
  await deck.finish();
});
