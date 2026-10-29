// TC-14：电脑重启后（tmux 服务没了）打开应用，弹 “Restore your last session?”，Restore all 后窗口在原位，
// claude 接回原来的对话（claude --resume <会话 id>），Shell 在原目录打开、上次跑的命令填在输入行里没运行。
//
// 怎么模拟重启：⌘Q 退出应用，再 kill 掉沙盒的 tmux 服务（重启后 tmux 里的会话全没了，和这个一样），再打开应用。
// 真的重启电脑仍要人工；codex resume <id> 没有假 codex（codex 的会话 id 靠 app-server + 钩子），只有适配器单测和 L1（K9）。
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { shieldRealAgents } from '../support/g4-env.ts';
import { makeRepo } from '../support/repo.ts';

test('TC-14 after a reboot (tmux server gone): Restore all brings claude back to its conversation and refills the shell', async ({ deck, sb }) => {
  shieldRealAgents(sb);
  const repo = makeRepo(sb, 'api');
  await deck.launch();
  const { workspaceId, path } = await setupWorktree(deck, repo, 'feat/reboot');
  // 前提：框里一个聊过的 claude、一个在跑 dev server 的 Shell
  const agent = await openFakeClaude(deck, workspaceId);
  const shell = await openTerminal(deck, workspaceId, 'shell');
  await deck.showAll();
  await deck.focusWindow(agent.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(agent.terminalId, 'running');
  await deck.typeLine('done first answer');
  await deck.waitForPane(agent.terminalId, /● first answer/);
  await deck.focusWindow(shell.windowId);
  await deck.waitForPane(shell.terminalId, /e2e\$/);
  await deck.typeLine('sleep 600');
  // 后台：窗口记下了会话 id 和 Shell 正在跑的命令（X6：跑了几秒的才记）
  await expect
    .poll(async () => (await deck.board()).windows.find((w) => w.id === shell.windowId)?.data['lastCommand'], { timeout: 30_000 })
    .toBe('sleep 600');
  const before = await deck.board();
  const sessionId = before.windows.find((w) => w.id === agent.windowId)!.data['sessionId'] as string;
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  await deck.screenshot('before-reboot');

  // “重启电脑”：退出应用，tmux 服务没了
  await deck.quit();
  expect(sb.tmux(['kill-server']).status).toBe(0);
  expect(sb.tmux(['has-session', '-t', `=${agent.terminalId}`]).status).not.toBe(0);

  // 1. 打开应用：弹恢复提示
  const page = await deck.launch();
  const dialog = page.getByRole('dialog', { name: 'Restore your last session?' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText('2 terminals in 1 workspace: 1 agent and 1 shell.');
  const rows = dialog.getByRole('list', { name: 'Terminals to restore' }).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'claude' })).toContainText('Resumes the conversation');
  await expect(rows.filter({ hasText: 'sleep 600' })).toContainText('typed in, not run');
  await deck.screenshot('restore-prompt');

  // 2. Restore all
  await dialog.getByRole('button', { name: 'Restore all' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Restored 2 terminals.')).toBeVisible();

  // UI：窗口在原位（同一个窗口 id、同样的位置大小），终端换了新的
  let after = await deck.board();
  await expect
    .poll(async () => {
      after = await deck.board();
      return [agent.windowId, shell.windowId].map((id) => after.windows.find((w) => w.id === id)?.data['terminalId'] ?? null);
    })
    .not.toContain(null);
  for (const id of [agent.windowId, shell.windowId]) {
    const a = after.windows.find((w) => w.id === id)!;
    const b = before.windows.find((w) => w.id === id)!;
    expect(a.rect).toEqual(b.rect);
    expect(a.workspaceId).toBe(workspaceId);
    expect(a.data['terminalId']).not.toBe(b.data['terminalId']);
  }
  const agentTerm = after.windows.find((w) => w.id === agent.windowId)!.data['terminalId'] as string;
  const shellTerm = after.windows.find((w) => w.id === shell.windowId)!.data['terminalId'] as string;

  // 后台：claude 按记下的会话 id 运行 claude --resume <id>，接回的还是那段对话
  await deck.waitForPane(agentTerm, new RegExp(`session: ${sessionId} \\(resumed\\)`));
  const log = deck.agentLog(agentTerm);
  const start = log.find((e) => e.kind === 'start') as { argv?: string[] } | undefined;
  expect(start?.argv?.slice(0, 2)).toEqual(['--resume', sessionId]);
  expect(log.some((e) => e.kind === 'hook' && e.event === 'SessionStart' && (e as { payload?: { source?: string } }).payload?.source === 'resume')).toBe(true);
  expect(after.windows.find((w) => w.id === agent.windowId)!.data['sessionId']).toBe(sessionId);
  await deck.waitForStatus(agentTerm, 'idle');

  // 后台：Shell 在原目录（worktree）重开，“sleep 600” 在输入行里，没有运行（前台还是 shell）
  await deck.waitForPane(shellTerm, /e2e\$ sleep 600/);
  expect(sb.tmux(['display-message', '-p', '-t', `=${shellTerm}:`, '#{pane_current_path}']).stdout.trim()).toBe(path);
  await expect
    .poll(() => sb.tmux(['display-message', '-p', '-t', `=${shellTerm}:`, '#{pane_current_command}']).stdout.trim(), { timeout: 5_000 })
    .toMatch(/^(bash|zsh|sh)$/);

  // 接回的 claude 照常能用
  await deck.focusWindow(agent.windowId);
  await deck.typeLine('done second answer');
  await deck.waitForPane(agentTerm, /● second answer/);
  await deck.screenshot('restored');
});
