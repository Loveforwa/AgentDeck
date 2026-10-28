// TC-11 在系统终端里接上同一个 agent 会话。
// 不真的打开 Terminal.app（会拉起别的应用）：主进程里记下 AgentDeck 要交给 osascript 的命令（support/system-terminal.ts），
// 测试自己在伪终端（node-pty）里跑这条命令，当作系统终端。“Terminal.app 真的弹出来并显示会话”这一步只能人工看。
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';
import { attachInPty, capturedSpawns, captureSystemTerminal, commandFromAppleScript, type PtySession } from '../support/system-terminal.ts';

test('TC-11 Open in system terminal attaches to the same tmux session; input and output stay in sync', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  await captureSystemTerminal(deck);
  // 前提：有一个在跑的 claude 终端
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/attach');
  const claude = await openFakeClaude(deck, workspaceId);
  await deck.showAll();
  await deck.focusWindow(claude.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(claude.terminalId, 'running');

  // 1. 标题栏右键 › Open in system terminal
  await deck.windowEl(claude.windowId).locator('.ad-window-titlebar').click({ button: 'right', position: { x: 80, y: 10 } });
  await deck.pickMenu(['Open in system terminal']);

  // 后台：交给系统终端（默认 Terminal，AppleScript do script）的是 tmux -L <AgentDeck 的 socket> attach-session -t =<id>
  let spawns: Awaited<ReturnType<typeof capturedSpawns>> = [];
  await expect.poll(async () => (spawns = await capturedSpawns(deck)).length).toBe(1);
  expect(spawns[0]!.cmd).toBe('/usr/bin/osascript');
  const script = spawns[0]!.args[spawns[0]!.args.indexOf('-e') + 1]!;
  expect(script).toMatch(/^tell application "Terminal"\nactivate\ndo script "/);
  const command = commandFromAppleScript(script);
  expect(command).not.toBeNull();
  // 不需要引号的参数不加引号（shQuote）
  expect(command).toMatch(new RegExp(`/tmux'? '?-L'? '?${sb.tmuxSocket}'? .*'?attach-session'? '?-t'? '?=${claude.terminalId}'?$`));

  // 自己当系统终端跑这条命令：接上的是同一个 tmux 会话（现在有两个客户端）
  let sys: PtySession | null = attachInPty(sb, command!);
  try {
    const clients = () => sb.tmux(['list-clients', '-t', `=${claude.terminalId}`, '-F', '#{client_tty}']).stdout.trim().split('\n').filter(Boolean);
    await expect.poll(() => clients().length, { timeout: 15_000 }).toBe(2);
    // 系统终端里显示同一个会话：假 claude 的开头和它的会话 id
    const session = /session: (\S+)/.exec(deck.pane(claude.terminalId))?.[1];
    expect(session).toBeTruthy();
    await expect.poll(() => sys!.text(), { timeout: 15_000 }).toContain(`session: ${session}`);

    // 2. 在两边各输入几个字
    // 系统终端这边：done reply-from-system → 进了同一个 claude（日志里有），AgentDeck 的窗口状态跟着变 Idle
    sys.write('done reply-from-system\r');
    await expect.poll(() => deck.agentLog(claude.terminalId).some((e) => e.kind === 'input' && e.line === 'done reply-from-system')).toBe(true);
    await deck.waitForStatus(claude.terminalId, 'idle');
    await expect(deck.windowEl(claude.windowId).locator('.ad-window-titlebar .ad-window-status')).toHaveText(/^Idle/);
    await deck.waitForPane(claude.terminalId, /● reply-from-system/);
    // AgentDeck 这边：真键盘打进窗口 → 系统终端里看得到输入和输出
    await deck.focusWindow(claude.windowId);
    await deck.typeLine('done reply-from-deck');
    await expect.poll(() => sys!.text(), { timeout: 15_000 }).toContain('● reply-from-deck');
    expect(sys.text()).toContain('done reply-from-deck');
    expect(deck.agentLog(claude.terminalId).filter((e) => e.kind === 'input').map((e) => e.line)).toEqual(
      expect.arrayContaining(['work', 'done reply-from-system', 'done reply-from-deck']),
    );
    await deck.screenshot('synced');

    // 关掉系统终端：只是断开一个客户端，会话和 AgentDeck 里的终端都还在
    sys.close();
    sys = null;
    await expect.poll(() => clients().length, { timeout: 15_000 }).toBe(1);
    expect(sb.tmux(['has-session', '-t', `=${claude.terminalId}`]).status).toBe(0);
    await expect(deck.windowEl(claude.windowId).locator('.ad-terminal__notice')).toHaveCount(0);
    expect(page.isClosed()).toBe(false);
  } finally {
    sys?.close();
  }
});
