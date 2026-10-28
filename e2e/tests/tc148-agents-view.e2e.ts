// TC-148（CO4）：右边 BoardNav 的 Agents 视图按状态分组列出所有 agent（不列 shell），悬停看最后一条回复和
// “Click to jump · ⌥⌘3”，⌥⌘3 跳过去并聚焦。全程真的：假 claude 的钩子 → 状态机；最后一条回复读 tmux 的屏幕。
// Unseen（做完还没看）2026-10-28 按用户决定去掉：状态本身（Idle）已经看得见。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal } from '../support/flows.ts';

const REPLY = 'The p99 spike comes from the cold pool in db/pool.ts:88';

/** 在白板的 at 处开一个假 claude，等它报 SessionStart（idle）。 */
async function fakeClaudeAt(deck: Deck, at: { x: number; y: number }) {
  const t = await openTerminal(deck, null, 'claude', undefined, at);
  await deck.waitForPane(t.terminalId, /Fake Claude/);
  await deck.waitForStatus(t.terminalId, 'idle');
  return t;
}

test('TC-148 Agents view groups agents by status, shows the last reply on hover and ⌥⌘3 jumps to it', async ({ deck }) => {
  await deck.launch();
  const { page } = deck;
  // 4 个 agent、1 个 shell，都散放：按位置是 waiting、running、finished、idle
  const waiting = await fakeClaudeAt(deck, { x: 40, y: 40 });
  const running = await fakeClaudeAt(deck, { x: 620, y: 40 });
  const finished = await fakeClaudeAt(deck, { x: 40, y: 440 });
  const idle = await fakeClaudeAt(deck, { x: 620, y: 440 });
  const shell = await openTerminal(deck, null, 'shell', undefined, { x: 1200, y: 40 });
  await page.keyboard.press('Meta+0');

  await deck.focusWindow(waiting.windowId);
  await deck.typeLine('ask');
  await deck.waitForStatus(waiting.terminalId, 'needs-approval');
  await deck.focusWindow(running.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(running.terminalId, 'running');
  await deck.focusWindow(finished.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(finished.terminalId, 'running');
  // 它做完一轮，留下一条回复（按键直接经 tmux 送进去，焦点不动）
  await deck.focusWindow(idle.windowId);
  deck.sb.tmux(['send-keys', '-t', `=${finished.terminalId}:`, '-l', `done ${REPLY}`]);
  deck.sb.tmux(['send-keys', '-t', `=${finished.terminalId}:`, 'Enter']);
  await deck.waitForStatus(finished.terminalId, 'idle');
  // 标题栏写 Idle
  await expect(deck.windowEl(finished.windowId).locator('.ad-window-status')).toHaveText(/^Idle · (now|\dm)$/);
  await expect(deck.windowEl(finished.windowId).locator('.ad-window-status')).toHaveClass(/ad-window-status--muted/);

  // 1. 点白板空白处：没有聚焦的窗口，右边出现 BoardNav（先缩小一点，留出空白处）
  await page.evaluate(() => (window as unknown as { __board: { zoomTo(z: number): void } }).__board.zoomTo(0.6));
  // 缩放有动画：等它停在 60%
  await expect.poll(async () => (await deck.board()).viewport.zoom).toBeCloseTo(0.6, 2);
  await expect.poll(() => page.evaluate(() => document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? '')).toContain('scale(0.6)');
  const empty = await deck.emptyPoint('bottom');
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();
  const nav = page.getByRole('navigation', { name: 'Board' });
  await expect(nav.getByRole('heading', { name: 'BOARD' })).toBeVisible();

  // 2. 点 Agents：只列 4 个 agent，分组顺序固定、带个数
  await nav.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(nav.getByRole('heading', { name: 'AGENTS · 4' })).toBeVisible();
  await expect(nav.getByRole('heading', { level: 3 })).toHaveText(['NEEDS YOU · 1', 'RUNNING · 1', 'IDLE · 2']);
  const rows = nav.locator('.bnav-agent-row');
  await expect(rows).toHaveCount(4);
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-window-id')))).toEqual([
    waiting.windowId,
    running.windowId,
    finished.windowId,
    idle.windowId,
  ]);
  await expect(nav.locator(`[data-window-id="${shell.windowId}"]`)).toHaveCount(0);
  // 做完的和一直空闲的都在 IDLE，组里按白板位置；右边只写时间，灯是空心灰
  const finishedRow = nav.locator(`[data-window-id="${finished.windowId}"]`);
  await expect(nav.getByRole('region', { name: 'IDLE' }).locator('.bnav-agent-row')).toHaveCount(2);
  await expect(finishedRow.locator('.bnav-agent-status')).toHaveText(/^(now|\dm)$/);
  await expect(finishedRow.locator('.bnav-lamp')).toHaveClass(/bnav-lamp--idle/);
  await deck.screenshot('agents-view');

  // 3. 悬停 IDLE 下做完一轮的 claude：黑色提示，最后一条回复和 “Click to jump · ⌥⌘3”
  await finishedRow.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/claude · Idle · (now|\dm)/);
  await expect(tip).toContainText('Last reply');
  await expect(tip).toContainText(REPLY);
  await expect(tip).toContainText('Click to jump · ⌥⌘3');
  await deck.screenshot('hover');
  await page.mouse.move(empty.x, empty.y);
  await expect(tip).toHaveCount(0);

  // 4. ⌥⌘3：跳到第 3 行的终端并聚焦
  await page.keyboard.press('Meta+Alt+Digit3');
  await expect.poll(async () => (await deck.board()).focusedId).toBe(finished.windowId);
  await expect(deck.windowEl(finished.windowId).locator('.ad-window-status')).toHaveText(/^Idle · (now|\dm)$/);

  // 5. 回到 Agents 视图（记住了上次选的）：分组不变
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();
  await expect(nav.getByRole('heading', { name: 'AGENTS · 4' })).toBeVisible();
  await expect(nav.getByRole('heading', { level: 3 })).toHaveText(['NEEDS YOU · 1', 'RUNNING · 1', 'IDLE · 2']);
  await expect(nav.getByRole('region', { name: 'IDLE' }).locator(`[data-window-id="${finished.windowId}"]`)).toBeVisible();
  await deck.screenshot('after');
});
