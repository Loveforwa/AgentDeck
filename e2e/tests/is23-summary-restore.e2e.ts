// IS-23：真窗口里把终端拉小成摘要卡、再恢复，画面会不会乱。TC-09 的主流程在 tc06-tc09-tc10-terminals（拉小两个、恢复一个）；
// 这里补“画面不乱”的客观判据：两个都恢复以后，xterm 的行列数和拉小前一样、tmux 窗格跟着回到这个大小，
// xterm 屏幕和 tmux 的画面一行对一行相同，摘要卡上是最后 3 行，恢复后照常输入、输出不错位。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { xtermOf } from '../support/g1.ts';
import { makeRepo } from '../support/repo.ts';

function paneSize(deck: Deck, terminalId: string): string {
  return deck.sb.tmux(['display-message', '-p', '-t', `=${terminalId}:`, '#{pane_width}x#{pane_height}']).stdout.trim();
}

function tmuxScreen(deck: Deck, terminalId: string): string[] {
  return deck.sb
    .tmux(['capture-pane', '-p', '-t', `=${terminalId}:`])
    .stdout.split('\n')
    .map((l) => l.trimEnd());
}

/** xterm 屏幕和 tmux 画面一行对一行相同，行列数和 tmux 窗格一样。 */
async function sameAsTmux(deck: Deck, windowId: string, terminalId: string): Promise<boolean> {
  const x = await xtermOf(deck.page, windowId);
  if (!x || paneSize(deck, terminalId) !== `${x.cols}x${x.rows}`) return false;
  const a = x.lines.map((l) => l.trimEnd());
  const b = tmuxScreen(deck, terminalId).slice(0, x.rows);
  while (b.length < a.length) b.push('');
  return JSON.stringify(a) === JSON.stringify(b);
}

test('IS-23 shrink a Shell and a claude to summary cards, restore both: same size, screen matches tmux, input still lines up', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'api');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/cards');
  // 前提：一个 Shell 打满了一屏多的输出，一个假 claude 在干活
  const shell = await openTerminal(deck, workspaceId, 'shell');
  const agent = await openFakeClaude(deck, workspaceId);
  await deck.showAll();
  await deck.focusWindow(shell.windowId);
  await deck.typeLine('seq 1 80; echo END-$((1+1))');
  await deck.waitForPane(shell.terminalId, /END-2/);
  await deck.focusWindow(agent.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(agent.terminalId, 'running');
  const terms = [shell, agent];
  for (const t of terms) await expect.poll(() => sameAsTmux(deck, t.windowId, t.terminalId), { message: `${t.terminalId} before` }).toBe(true);
  const before = await deck.board();
  const rectOf = (b: typeof before, id: string) => b.windows.find((w) => w.id === id)!.rect;
  const sizeBefore = new Map<string, string>();
  for (const t of terms) {
    const x = (await xtermOf(page, t.windowId))!;
    sizeBefore.set(t.windowId, `${x.cols}x${x.rows}`);
  }
  await deck.screenshot('before');

  // 1. 两个终端的右下角往里拉到很小（真鼠标拖改大小的角）
  for (const t of terms) {
    const handle = deck.windowEl(t.windowId).locator('.ad-window-resize--se');
    const box = (await handle.boundingBox())!;
    const zoom = (await deck.board()).viewport.zoom;
    const rect = rectOf(await deck.board(), t.windowId);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - (rect.w - 240) * zoom, y - (rect.h - 130) * zoom, { steps: 15 });
    await page.mouse.up();
    await expect(deck.windowEl(t.windowId)).toHaveAttribute('data-summary', 'true');
  }
  // UI：摘要卡上是最后 3 行（Shell：80、END-2、提示符；claude：Working…），状态还在标题栏
  const shellLines = deck.windowEl(shell.windowId).locator('.ad-terminal__summary-line');
  await expect(shellLines).toHaveCount(3);
  const lastThree = tmuxScreen(deck, shell.terminalId).filter((l) => l.trim() !== '').slice(-3);
  expect(lastThree[0]).toBe('80');
  await expect(shellLines).toHaveText(lastThree.map((l) => l.trim()));
  await expect(deck.windowEl(agent.windowId).locator('.ad-terminal__summary-line').last()).toContainText('Working');
  await expect(deck.windowEl(agent.windowId).locator('.ad-window-status')).toHaveText(/^Running/);
  // 摘要卡不 attach：tmux 里这两个会话没有客户端
  const clients = () => sb.tmux(['list-clients', '-F', '#{client_session}']).stdout.split('\n');
  for (const t of terms) await expect.poll(() => clients().includes(t.terminalId)).toBe(false);
  await deck.screenshot('summary-cards');

  // 摘要卡期间 claude 照样出字：恢复时要接上新的画面
  sb.tmux(['send-keys', '-t', `=${agent.terminalId}:`, 'done', 'Enter']);
  await deck.waitForPane(agent.terminalId, /Done\./);
  await deck.waitForStatus(agent.terminalId, 'idle');

  // 2. 单击两个摘要卡：各自恢复到拉小之前的大小并聚焦
  for (const t of terms) {
    await deck.windowEl(t.windowId).locator('.ad-window-content').click({ delay: 80 });
    await expect(deck.windowEl(t.windowId)).not.toHaveAttribute('data-summary', 'true');
    await expect.poll(async () => rectOf(await deck.board(), t.windowId)).toEqual(rectOf(before, t.windowId));
    await expect.poll(async () => (await deck.board()).focusedId).toBe(t.windowId);
    await expect(deck.windowEl(t.windowId).locator('.ad-terminal__notice')).toHaveCount(0);
    await expect.poll(() => clients().filter((c) => c === t.terminalId).length).toBe(1);
  }
  // 画面不乱：行列数和拉小前一样，tmux 窗格跟着回到这个大小，xterm 屏幕和 tmux 一行对一行
  for (const t of terms) {
    await expect.poll(async () => {
      const x = await xtermOf(page, t.windowId);
      return x ? `${x.cols}x${x.rows}` : '';
    }).toBe(sizeBefore.get(t.windowId));
    await expect.poll(() => sameAsTmux(deck, t.windowId, t.terminalId), { message: `${t.terminalId} after restore` }).toBe(true);
  }
  // 两个窗口不重叠
  const after = await deck.board();
  const [ra, rb] = [rectOf(after, shell.windowId), rectOf(after, agent.windowId)];
  expect(ra.x + ra.w <= rb.x || rb.x + rb.w <= ra.x || ra.y + ra.h <= rb.y || rb.y + rb.h <= ra.y).toBe(true);
  await deck.screenshot('restored-both');

  // 恢复后照常输入，输出落在对的位置
  await deck.focusWindow(shell.windowId);
  await deck.typeLine('echo again-$((2+2))');
  await deck.waitForPane(shell.terminalId, /^again-4$/m);
  await expect.poll(() => sameAsTmux(deck, shell.windowId, shell.terminalId)).toBe(true);
  await deck.focusWindow(agent.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(agent.terminalId, 'running');
  await expect.poll(() => sameAsTmux(deck, agent.windowId, agent.terminalId)).toBe(true);
  await deck.screenshot('typed-after-restore');
});
