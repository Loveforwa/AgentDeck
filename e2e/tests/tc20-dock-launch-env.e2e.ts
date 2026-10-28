// TC-20：从程序坞 / 访达打开时 Electron 只拿到 launchd 给的很少的环境（PATH=/usr/bin:/bin:/usr/sbin:/sbin，没有 shell 配置里的
// 代理变量，有时连 SHELL 都没有）。AgentDeck 启动时读登录 shell 的环境，agent 照样找得到、带着代理变量。
//
// 怎么模拟：用 launchd 那样的最小环境启动 Electron（只多 AGENTDECK_DATA_DIR / AGENTDECK_TMUX_SOCKET 两个隔离用的变量），
// 代理变量只写在沙盒的登录配置里（.bash_profile / .zprofile），PATH 里的假 claude 也只有登录配置里有。
// 真的从程序坞点开打包好的应用（IS-11、IS-36）、真 claude 联网不报 403 仍要人工。
import { join } from 'node:path';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude } from '../support/flows.ts';
import { appendProfile, panePid, processEnv, shieldRealAgents, writeZshProfile } from '../support/g4-env.ts';
import type { Sandbox } from '../support/sandbox.ts';
import type { Deck } from '../support/deck.ts';

const PROXY = 'http://127.0.0.1:9/';

/** 换成 launchd 给 GUI 应用的那种环境。withShell 为 false 时连 SHELL 都没有（AgentDeck 用系统记录的 shell）。 */
function launchdEnv(sb: Sandbox, withShell: boolean): void {
  const keep: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: sb.env['HOME']!,
    USER: sb.env['USER']!,
    LOGNAME: sb.env['LOGNAME']!,
    TMPDIR: sb.env['TMPDIR']!,
    AGENTDECK_DATA_DIR: sb.env['AGENTDECK_DATA_DIR']!,
    AGENTDECK_TMUX_SOCKET: sb.env['AGENTDECK_TMUX_SOCKET']!,
  };
  if (withShell) keep['SHELL'] = '/bin/bash';
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) if (sb.env[k]) keep[k] = sb.env[k]!;
  for (const k of Object.keys(sb.env)) delete sb.env[k];
  Object.assign(sb.env, keep);
}

async function checkAgentGetsLoginEnv(deck: Deck, sb: Sandbox) {
  const page = deck.page;
  // UI：没有“读不到登录环境”的提示
  await expect(page.getByText(/Couldn’t read your login shell environment/)).toHaveCount(0);
  // 后台：检测按登录 PATH 找到了 claude（假的，在沙盒的 fakebin 里）
  const claude = await page.evaluate(async () => {
    const w = window as unknown as { agentdeck: { agents: { list(): Promise<{ id: string; installed: boolean; version: string | null; path?: string | null }[]> } } };
    return (await w.agentdeck.agents.list()).find((a) => a.id === 'claude') ?? null;
  });
  expect(claude).toMatchObject({ installed: true, version: '2.1.291' });

  // 2. 新开一个 claude，发一句话：正常回答，不是 “command not found”
  const t = await openFakeClaude(deck, null);
  await deck.focusWindow(t.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(t.terminalId, 'running');
  await deck.typeLine('done PELICAN');
  await deck.waitForPane(t.terminalId, /● PELICAN/);
  await deck.waitForStatus(t.terminalId, 'idle');
  expect(deck.pane(t.terminalId)).not.toMatch(/command not found|403/);

  // 后台：agent 进程的环境是登录 shell 的：PATH 是登录配置里的那串（最前面另加了 AgentDeck 自己的 <数据目录>/bin，CR15），
  // 带着代理变量
  const env = processEnv(panePid(sb, t.terminalId));
  const path = (env['PATH'] ?? '').split(':').filter((d) => d !== join(sb.dataDir, 'bin'));
  expect(path.slice(0, 3)).toEqual(sb.path.split(':').slice(0, 3));
  expect(env['HTTPS_PROXY']).toBe(PROXY);
  expect(env['https_proxy']).toBe(PROXY);
  expect(env['AGENTDECK_E2E_PROFILE']).toBe('login-shell');
  await deck.screenshot('claude-answered');
}

test.beforeEach(({ sb }) => {
  shieldRealAgents(sb);
  writeZshProfile(sb);
  appendProfile(sb, [`export HTTPS_PROXY=${PROXY}`, `export https_proxy=${PROXY}`, 'export AGENTDECK_E2E_PROFILE=login-shell']);
});

test('TC-20 launched with the launchd environment (Dock): agents get the login shell PATH and proxy variables', async ({ deck, sb }) => {
  launchdEnv(sb, true);
  // 1. “从程序坞打开”
  await deck.launch();
  await checkAgentGetsLoginEnv(deck, sb);
});

test('TC-20 launched without SHELL in the environment: the user’s login shell is still read', async ({ deck, sb }) => {
  launchdEnv(sb, false);
  await deck.launch();
  await checkAgentGetsLoginEnv(deck, sb);
});
