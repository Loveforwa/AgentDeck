// TC-37（N6）白板手势：没聚焦的终端上两指滚动只滚终端内容；空白处两指滚动平移白板；捏合缩放白板；按住空格拖动平移；
// 终端里 Shift+空格照常输入。滚轮、捏合（macOS 的捏合到页面里是带 ctrlKey 的 wheel）、空格和拖动都用 Playwright 的真输入事件（CDP）模拟；
// 触控板的惯性、顺滑程度只能人试。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal } from '../support/flows.ts';
import { centerOf } from '../support/g1.ts';

const vp = async (deck: Deck) => (await deck.board()).viewport;
const rectOf = async (deck: Deck, id: string) => (await deck.board()).windows.find((w) => w.id === id)!.rect;
/** 等视口停下（连续两次读到一样的）。 */
async function settled(deck: Deck) {
  let last = '';
  await expect
    .poll(
      async () => {
        const v = JSON.stringify(await vp(deck));
        const same = v === last;
        last = v;
        return same;
      },
      { intervals: [250] },
    )
    .toBe(true);
  return vp(deck);
}

test('TC-37 board gestures: wheel over a window scrolls it, wheel on the board pans, pinch zooms, space-drag pans, Shift+Space types', async ({ deck, sb }) => {
  const page = await deck.launch();
  // 前提：白板上有一个没聚焦的终端（有好几屏输出，能往回滚）和一个网页窗口
  const term = await openTerminal(deck, null, 'shell', undefined, { x: 40, y: 40 });
  await deck.waitForPane(term.terminalId, /e2e\$/);
  sb.tmux(['send-keys', '-t', `=${term.terminalId}:`, '-l', 'seq 1 400']);
  sb.tmux(['send-keys', '-t', `=${term.terminalId}:`, 'Enter']);
  await deck.waitForPane(term.terminalId, /^400$/m);
  const browserId = await page.evaluate(
    () => (window as unknown as { __board: { newBrowser(o: object): string | null } }).__board.newBrowser({ workspaceId: null, at: { x: 660, y: 40 } }),
  );
  expect(browserId).not.toBeNull();
  await page.keyboard.press('Meta+0');
  // 什么都不聚焦
  const empty = await deck.emptyPoint('bottom');
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();
  const v0 = await settled(deck);
  const termRect = await rectOf(deck, term.windowId);

  // 1. 鼠标停在没聚焦的终端上两指滚动（往上）：终端往回滚（tmux 进入回滚），白板不动
  const overTerm = await centerOf(page, `.ad-window-node[data-window-id="${term.windowId}"] .ad-window-content`);
  await page.mouse.move(overTerm.x, overTerm.y);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -120);
  await expect.poll(() => sb.tmux(['display-message', '-p', '-t', `=${term.terminalId}:`, '#{pane_in_mode}']).stdout.trim()).toBe('1');
  await expect.poll(() => Number(sb.tmux(['display-message', '-p', '-t', `=${term.terminalId}:`, '#{scroll_position}']).stdout.trim())).toBeGreaterThan(0);
  expect(await settled(deck)).toEqual(v0);
  expect((await deck.board()).focusedId).toBeNull();
  await deck.screenshot('wheel-over-terminal');
  // 网页窗口上滚动也一样不动白板（滚轮交给窗口内容）
  const overWeb = await centerOf(page, `.ad-window-node[data-window-id="${browserId}"] .ad-window-content`);
  await page.mouse.move(overWeb.x, overWeb.y);
  await page.mouse.wheel(0, 200);
  expect(await settled(deck)).toEqual(v0);
  // 回滚退出来（按 q），免得影响后面
  sb.tmux(['send-keys', '-t', `=${term.terminalId}:`, 'q']);

  // 2. 在空白处两指滚动：平移白板，比例不变
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.wheel(80, 160);
  const v1 = await settled(deck);
  expect(v1.zoom).toBe(v0.zoom);
  expect(v1.y).toBeLessThan(v0.y);
  expect(v1.x).toBeLessThan(v0.x);
  // 窗口在白板上的位置没变（是视口在动）
  expect(await rectOf(deck, term.windowId)).toEqual(termRect);
  await deck.screenshot('wheel-pan');

  // 3. 捏合（带 ctrl 的滚轮）：缩放白板，以指针为不动点
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 60);
  await page.keyboard.up('Control');
  const v2 = await settled(deck);
  expect(v2.zoom).toBeLessThan(v1.zoom);
  // 指针下的白板坐标不变
  const origin = await page.evaluate(() => {
    const r = document.querySelector('.react-flow')!.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  const at = (v: typeof v1) => ({ x: (empty.x - origin.x - v.x) / v.zoom, y: (empty.y - origin.y - v.y) / v.zoom });
  expect(at(v2).x).toBeCloseTo(at(v1).x, 0);
  expect(at(v2).y).toBeCloseTo(at(v1).y, 0);
  await deck.screenshot('pinch');
  // 视口放回原点（准备下一步）
  await page.evaluate(() => (window as unknown as { __board: { setViewport(v: object, d?: number): void } }).__board.setViewport({ x: 0, y: 0, zoom: 1 }, 0));
  await expect.poll(async () => JSON.stringify(await vp(deck))).toBe(JSON.stringify({ x: 0, y: 0, zoom: 1 }));
  const v3 = await settled(deck);

  // 4. 按住空格拖动（从终端上开始拖）：平移白板，终端没被拖走
  await page.mouse.click(empty.x, empty.y);
  const from = await centerOf(page, `.ad-window-node[data-window-id="${term.windowId}"] .ad-window-titlebar`);
  await page.keyboard.down('Space');
  await expect(page.locator('.ad-board--space-pan')).toHaveCount(1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 150, from.y + 90, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect(page.locator('.ad-board--space-pan')).toHaveCount(0);
  const v4 = await settled(deck);
  expect(v4.x - v3.x).toBeCloseTo(150, -1);
  expect(v4.y - v3.y).toBeCloseTo(90, -1);
  expect(await rectOf(deck, term.windowId)).toEqual(termRect);
  await deck.screenshot('space-pan');

  // 5. 在终端里打 Shift+空格：照常打出空格（白板不拿走）
  await deck.focusWindow(term.windowId);
  await page.keyboard.type('echo shift', { delay: 15 });
  await page.keyboard.press('Shift+Space');
  await page.keyboard.type('space', { delay: 15 });
  await page.keyboard.press('Enter');
  await deck.waitForPane(term.terminalId, /^shift space$/m);
  expect(await settled(deck)).toEqual(v4);
  await deck.screenshot('shift-space');
});
