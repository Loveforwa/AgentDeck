// TC-148（CO4）：右边 BoardNav 的 Agents 视图按状态列出所有 agent（不列 shell），做完还没看的标 Unseen（标题栏 “Idle · Unseen”、
// 列表粗体），悬停看最后一条回复和 “Click to jump · ⌥⌘3”，⌥⌘3 跳过去并聚焦，回来后它移到 IDLE、Unseen 没了。
// 全程真的：假 claude 的钩子 → 状态机 → agent.turn-end → 白板记 Unseen（随白板保存）；最后一条回复读 tmux 的屏幕。
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

test('TC-148 Agents view groups agents by status, marks a finished one Unseen, shows its last reply on hover and ⌥⌘3 jumps to it', async ({ deck }) => {
  await deck.launch();
  const { page } = deck;
  // 4 个 agent、1 个 shell，都散放：按位置是 waiting、running、unseen、idle
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
  // 你去看别的终端了，这时它做完一轮（按键直接经 tmux 送进去，焦点不动）
  await deck.focusWindow(idle.windowId);
  deck.sb.tmux(['send-keys', '-t', `=${finished.terminalId}:`, '-l', `done ${REPLY}`]);
  deck.sb.tmux(['send-keys', '-t', `=${finished.terminalId}:`, 'Enter']);
  await deck.waitForStatus(finished.terminalId, 'idle');

  // 后台：Unseen 记在窗口数据上，随白板保存
  const dataOf = async (windowId: string) => (await deck.board()).windows.find((w) => w.id === windowId)!.data as { unseen?: boolean };
  await expect.poll(async () => (await dataOf(finished.windowId)).unseen).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        type Saved = { windows: { id: string; data: { unseen?: boolean } }[] } | null;
        const api = (window as unknown as { agentdeck: { board: { load(): Promise<Saved> } } }).agentdeck;
        const b = await api.board.load();
        return b?.windows.find((w) => w.id === id)?.data.unseen ?? null;
      }, finished.windowId),
    )
    .toBe(true);
  // 标题栏只改文字
  await expect(deck.windowEl(finished.windowId).locator('.ad-window-status')).toHaveText(/^Idle · Unseen · (now|\dm)$/);
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
  await expect(nav.getByRole('heading', { level: 3 })).toHaveText(['NEEDS YOU · 1', 'RUNNING · 1', 'DONE · UNSEEN · 1', 'IDLE · 1']);
  const rows = nav.locator('.bnav-agent-row');
  await expect(rows).toHaveCount(4);
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-window-id')))).toEqual([
    waiting.windowId,
    running.windowId,
    finished.windowId,
    idle.windowId,
  ]);
  await expect(nav.locator(`[data-window-id="${shell.windowId}"]`)).toHaveCount(0);
  const unseenRow = nav.locator(`[data-window-id="${finished.windowId}"]`);
  // Unseen 用粗体，不加颜色：文字是墨色，灯是空心灰
  const look = await unseenRow.evaluate((el) => {
    const name = el.querySelector('.bnav-name')!;
    const status = el.querySelector('.bnav-agent-status')!;
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
    const probe = document.createElement('span');
    probe.style.color = ink;
    document.body.append(probe);
    const inkRgb = getComputedStyle(probe).color;
    probe.remove();
    return {
      weight: getComputedStyle(name).fontWeight,
      statusText: status.textContent,
      statusWeight: getComputedStyle(status).fontWeight,
      statusColor: getComputedStyle(status).color,
      inkRgb,
      lamp: el.querySelector('.bnav-lamp')!.className,
    };
  });
  expect(look.weight).toBe('600');
  expect(look.statusText).toMatch(/^Unseen · (now|\dm)$/);
  expect(look.statusWeight).toBe('600');
  expect(look.statusColor).toBe(look.inkRgb);
  expect(look.lamp).toContain('bnav-lamp--idle');
  await deck.screenshot('agents-view');

  // 3. 悬停 DONE · UNSEEN 下的 claude：黑色提示，最后一条回复和 “Click to jump · ⌥⌘3”
  await unseenRow.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/claude · Idle · Unseen · (now|\dm)/);
  await expect(tip).toContainText('Last reply');
  await expect(tip).toContainText(REPLY);
  await expect(tip).toContainText('Click to jump · ⌥⌘3');
  await deck.screenshot('hover');
  await page.mouse.move(empty.x, empty.y);
  await expect(tip).toHaveCount(0);

  // 4. ⌥⌘3：跳到第 3 行的终端并聚焦
  await page.keyboard.press('Meta+Alt+Digit3');
  await expect.poll(async () => (await deck.board()).focusedId).toBe(finished.windowId);
  await expect.poll(async () => (await dataOf(finished.windowId)).unseen ?? false).toBe(false);
  await expect(deck.windowEl(finished.windowId).locator('.ad-window-status')).toHaveText(/^Idle · (now|\dm)$/);

  // 5. 回到 Agents 视图（记住了上次选的）：它移到 IDLE，Unseen 没了
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();
  await expect(nav.getByRole('heading', { name: 'AGENTS · 4' })).toBeVisible();
  await expect(nav.getByRole('heading', { level: 3 })).toHaveText(['NEEDS YOU · 1', 'RUNNING · 1', 'IDLE · 2']);
  await expect(nav.getByRole('region', { name: 'IDLE' }).locator(`[data-window-id="${finished.windowId}"]`)).toBeVisible();
  await expect(nav.locator('.bnav-row--unseen')).toHaveCount(0);
  await deck.screenshot('after');
});
