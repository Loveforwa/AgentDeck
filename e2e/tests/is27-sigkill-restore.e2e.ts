// IS-27：强杀应用进程（kill -9 主进程，不是 ⌘Q）后再打开，布局和终端恢复。和 TC-10 一样的预期，只是退出方式换成 SIGKILL：
// 主进程来不及存白板、关钩子 socket、断开 tmux 客户端，下次启动要自己收拾这些残留。
import { execFileSync } from 'node:child_process';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';

/** tmux 里这个会话有没有 attach 着的客户端（白板的终端窗口显示它时就有一个）。 */
function clientsOf(deck: Deck, terminalId: string): number {
  return deck.sb.tmux(['list-clients', '-F', '#{client_session}']).stdout.split('\n').filter((s) => s === terminalId).length;
}

/** 这个沙盒的 AgentDeck 还活着的进程（主进程、渲染、GPU、utilityProcess 都带着沙盒的 --user-data-dir）。 */
function appProcesses(deck: Deck): string[] {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes(deck.sb.userDataDir));
}

/** 库里存的白板（board.load）里各窗口、各框的位置。 */
async function savedLayout(deck: Deck) {
  return deck.page.evaluate(async () => {
    const api = (window as unknown as { agentdeck: { board: { load(): Promise<{ frames: { workspaceId: string; rect: object }[]; windows: { id: string; rect: object }[] }> } } }).agentdeck;
    const s = await api.board.load();
    return {
      frames: s.frames.map((f) => ({ ws: f.workspaceId, rect: f.rect })),
      windows: s.windows.map((w) => ({ id: w.id, rect: w.rect })),
    };
  });
}

function layoutOf(b: Awaited<ReturnType<Deck['board']>>) {
  return {
    frames: b.frames.map((f) => ({ ws: f.workspaceId, rect: f.rect })),
    windows: b.windows.map((w) => ({ id: w.id, rect: w.rect })),
  };
}

test('IS-27 kill -9 the main process and reopen: layout, terminals, hooks and input all come back', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'api');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/crash');
  // 前提：框里一个 Shell（有历史输出）、一个假 claude（在干活）
  const shell = await openTerminal(deck, workspaceId, 'shell');
  const agent = await openFakeClaude(deck, workspaceId);
  await deck.showAll();
  await deck.focusWindow(shell.windowId);
  await deck.typeLine('echo crash-marker-$((6*7))');
  await deck.waitForPane(shell.terminalId, /crash-marker-42/);
  await deck.focusWindow(agent.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(agent.terminalId, 'running');

  // 用真鼠标把 Shell 拖开一段（布局不是刚开出来的默认位置），等白板自动保存进库
  const before0 = await deck.board();
  const zoom = before0.viewport.zoom;
  const title = deck.windowEl(shell.windowId).locator('.ad-window-titlebar');
  const box = (await title.boundingBox())!;
  const from = { x: box.x + 60, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 5, from.y + 5, { steps: 2 });
  await page.mouse.move(from.x + 30 * zoom, from.y + 260 * zoom, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => (await deck.board()).windows.find((w) => w.id === shell.windowId)!.rect)
    .not.toEqual(before0.windows.find((w) => w.id === shell.windowId)!.rect);
  const before = await deck.board();
  // 自动保存（500ms 防抖）落进库之后再杀：强杀前最后半秒的改动丢了是预期的，这里测的是“存过的都能回来”
  await expect.poll(() => savedLayout(deck), { timeout: 10_000 }).toEqual(layoutOf(before));
  expect(clientsOf(deck, shell.terminalId)).toBe(1);
  expect(clientsOf(deck, agent.terminalId)).toBe(1);
  await deck.screenshot('before-kill');

  // 1. kill -9 主进程（不走 ⌘Q、不走 before-quit）
  const proc = deck.app.process();
  const exited = new Promise<void>((resolve) => (proc.exitCode !== null || proc.signalCode !== null ? resolve() : proc.once('exit', () => resolve())));
  expect(proc.kill('SIGKILL')).toBe(true);
  await exited;
  expect(proc.signalCode).toBe('SIGKILL');

  // 后台：渲染、GPU、终端 utilityProcess 跟着退出，不留孤儿进程
  await expect.poll(() => appProcesses(deck), { timeout: 20_000, message: 'AgentDeck helper processes left after kill -9' }).toEqual([]);
  // 后台：tmux 会话一直在跑，假 claude 没退出；utilityProcess 死了，它的 tmux 客户端也断开了
  expect(sb.tmux(['has-session', '-t', `=${shell.terminalId}`]).status).toBe(0);
  expect(sb.tmux(['has-session', '-t', `=${agent.terminalId}`]).status).toBe(0);
  expect(deck.agentLog(agent.terminalId).some((e) => e.kind === 'exit')).toBe(false);
  await expect.poll(() => clientsOf(deck, shell.terminalId) + clientsOf(deck, agent.terminalId)).toBe(0);
  // 应用不在时 claude 照样干活、发钩子（钩子 socket 没人听，agentdeck-notify 不能把 claude 卡住）
  sb.tmux(['send-keys', '-t', `=${agent.terminalId}:`, 'done', 'Enter']);
  await deck.waitForPane(agent.terminalId, /Done\./);
  await expect
    .poll(() => deck.agentLog(agent.terminalId).filter((e) => e.kind === 'hook' && e.event === 'Stop').length, { message: 'Stop hook ran while the app was dead' })
    .toBe(1);

  // 2. 再打开（同一个数据目录、同一个 tmux）
  await deck.launch();
  // UI：框和窗口的位置、大小和强杀前一样
  const after = await deck.board();
  expect(layoutOf(after)).toEqual(layoutOf(before));
  expect(after.windows.map((w) => w.data['terminalId'])).toEqual(before.windows.map((w) => w.data['terminalId']));
  expect(Object.keys(after.workspaces)).toEqual(Object.keys(before.workspaces));
  // UI：终端接回（每个会话正好一个客户端，没有 Previous session ended 之类的提示），历史输出都在
  for (const t of [shell, agent]) {
    await expect.poll(() => clientsOf(deck, t.terminalId), { message: `${t.terminalId} re-attached once` }).toBe(1);
    await expect(deck.windowEl(t.windowId).locator('.ad-terminal__notice')).toHaveCount(0);
  }
  // 不是“重启后恢复”的情况（tmux 会话都在），不该问 Restore your last session?
  await expect(deck.page.getByText('Restore your last session?')).toHaveCount(0);
  expect(deck.pane(shell.terminalId)).toContain('crash-marker-42');
  expect(deck.pane(agent.terminalId)).toContain('Working');
  await deck.screenshot('after-reopen');

  // 后台：状态机重新登记了这些终端；钩子 socket 重新监听（旧的 socket 文件没挡住），新的钩子能到
  await expect.poll(() => deck.status(agent.terminalId)).not.toBeNull();
  await deck.focusWindow(agent.windowId);
  await deck.typeLine('ask npm test');
  await deck.waitForStatus(agent.terminalId, 'needs-approval');
  await expect(deck.windowEl(agent.windowId).locator('.ad-window-status--attention')).toHaveText(/^Waiting/);
  await deck.page.keyboard.press('1');
  await deck.waitForStatus(agent.terminalId, 'running');
  await deck.typeLine('done');
  await deck.waitForStatus(agent.terminalId, 'idle');
  // Shell 的输入也照常进去
  await deck.focusWindow(shell.windowId);
  await deck.typeLine('echo after-$((40+2))');
  await deck.waitForPane(shell.terminalId, /after-42/);
  await deck.screenshot('working-after-reopen');

  // 再正常 ⌘Q、再开一次：强杀那次没把库弄坏，布局照样在
  await deck.quit();
  await deck.launch();
  expect(layoutOf(await deck.board())).toEqual(layoutOf(before));
});
