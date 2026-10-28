// TC-31（V3）窗口和工作区框互不遮挡，拖动有对齐线：靠近时吸附并画蓝色对齐线；放到另一个终端上松手滑到最近的空位、不重叠；
// 框拖到另一个框上停在它边上（相隔 20）；改大小到和旁边一样宽时吸住并标出尺寸；不弹“要不要换框”。
// 后台：避让只在松手时算，拖动中不推别的窗口。全程真的鼠标（按住标题栏拖、拖右下角），位置从白板状态（会存盘的那份）读回来。
// 手感（吸附力度、对齐线出现的时机）要人在真窗口里试。
import type { Page } from '@playwright/test';
import type { Deck, Rect } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal, setupWorktree } from '../support/flows.ts';
import { overlaps } from '../support/g1.ts';
import { makeRepo } from '../support/repo.ts';

const rectOf = async (deck: Deck, id: string): Promise<Rect> => (await deck.board()).windows.find((w) => w.id === id)!.rect;
const frameOf = async (deck: Deck, ws: string): Promise<Rect> => (await deck.board()).frames.find((f) => f.workspaceId === ws)!.rect;
const guides = (page: Page) => page.locator('[data-testid="snap-guides"] .ad-guide-line');
const labels = (page: Page) => page.locator('[data-testid="snap-guides"] .ad-guide-label');
const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** 两个框之间的空隙（不重叠时，水平或竖直方向上的距离）。 */
function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.max(dx, dy);
}

test('TC-31 windows and frames never overlap; dragging snaps with guides; equal width snaps with a size label', async ({ deck, sb }) => {
  const page = await deck.launch();
  const api = makeRepo(sb, 'api');
  const shop = makeRepo(sb, 'shop');
  // 前提：一个框里有两个终端；白板上有两个框
  const A = await setupWorktree(deck, api, 'feat/snap');
  const B = await setupWorktree(deck, shop, 'feat/other');
  const t1 = await openTerminal(deck, A.workspaceId, 'shell');
  const t2 = await openTerminal(deck, A.workspaceId, 'shell');
  await openTerminal(deck, B.workspaceId, 'shell');
  await deck.showAll();
  const zoom = (await deck.board()).viewport.zoom;
  const toScreen = (flow: number) => flow * zoom;
  const r1 = await rectOf(deck, t1.windowId);
  const title = (id: string) => deck.windowEl(id).locator('.ad-window-titlebar');
  const dialogs = page.getByRole('dialog');

  // 1. 拖 t2 靠近 t1：先往下拖开，再拖回到顶边只差 4（屏幕 6px 以内）——吸附到同一条顶边，画蓝色对齐线
  let r2 = await rectOf(deck, t2.windowId);
  let box = (await title(t2.windowId).boundingBox())!;
  let from = { x: box.x + 60, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 5, from.y + 5, { steps: 2 });
  await page.mouse.move(from.x + toScreen(40), from.y + toScreen(200), { steps: 10 });
  await page.mouse.move(from.x + toScreen(40), from.y + toScreen(r1.y - r2.y + 4), { steps: 10 });
  // 拖动中：吸住了（顶边对齐），对齐线是 --guide 色
  await expect.poll(async () => (await rectOf(deck, t2.windowId)).y).toBe(r1.y);
  // （横的线高度为 0，Playwright 不算“可见”，这里看有没有画出来）
  await expect(guides(page)).not.toHaveCount(0);
  const guideColor = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--guide)';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(await guides(page).first().evaluate((el) => getComputedStyle(el).stroke)).toBe(guideColor);
  // 拖动中 t1 没被推开
  expect(await rectOf(deck, t1.windowId)).toEqual(r1);
  await deck.screenshot('snap-guides');
  await page.mouse.up();
  await expect(guides(page)).toHaveCount(0);
  r2 = await rectOf(deck, t2.windowId);
  expect(r2.y).toBe(r1.y);
  expect(overlaps(r1, r2)).toBe(false);
  await expect(dialogs).toHaveCount(0);

  // 2. 把 t2 拖到 t1 正上面松手：拖动中 t1 不动；松手滑到最近的空位，不叠在一起，框装得下两个
  box = (await title(t2.windowId).boundingBox())!;
  from = { x: box.x + 60, y: box.y + box.height / 2 };
  const onTop = { x: from.x + toScreen(r1.x - r2.x + 30), y: from.y + toScreen(r1.y - r2.y + 30) };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 5, from.y + 5, { steps: 2 });
  await page.mouse.move(onTop.x, onTop.y, { steps: 15 });
  expect(overlaps(await rectOf(deck, t2.windowId), r1)).toBe(true);
  expect(await rectOf(deck, t1.windowId)).toEqual(r1);
  await deck.screenshot('drag-over');
  await page.mouse.up();
  await expect.poll(async () => overlaps(await rectOf(deck, t2.windowId), r1)).toBe(false);
  expect(await rectOf(deck, t1.windowId)).toEqual(r1);
  r2 = await rectOf(deck, t2.windowId);
  const fa = await frameOf(deck, A.workspaceId);
  expect(contains(fa, r1)).toBe(true);
  expect(contains(fa, r2)).toBe(true);
  // 还在原来的框里，没有弹“要不要换框”
  expect((await deck.board()).windows.find((w) => w.id === t2.windowId)!.workspaceId).toBe(A.workspaceId);
  await expect(dialogs).toHaveCount(0);
  await deck.screenshot('settled');

  // 3. 拖框 B（按住标题）到框 A 上：松手后停在 A 边上，相隔 20，不重叠
  await deck.showAll();
  const z2 = (await deck.board()).viewport.zoom;
  let fA = await frameOf(deck, A.workspaceId);
  const fB0 = await frameOf(deck, B.workspaceId);
  const header = deck.frameEl('feat/other').locator('.ad-frame-header').first();
  const hb = (await header.boundingBox())!;
  const hFrom = { x: hb.x + 40, y: hb.y + hb.height / 2 };
  await page.mouse.move(hFrom.x, hFrom.y);
  await page.mouse.down();
  await page.mouse.move(hFrom.x + 5, hFrom.y + 5, { steps: 2 });
  await page.mouse.move(hFrom.x + (fA.x - fB0.x + 40) * z2, hFrom.y + (fA.y - fB0.y + 40) * z2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(async () => overlaps(await frameOf(deck, A.workspaceId), await frameOf(deck, B.workspaceId))).toBe(false);
  fA = await frameOf(deck, A.workspaceId);
  const fB = await frameOf(deck, B.workspaceId);
  expect(gapBetween(fA, fB)).toBe(20);
  await expect(dialogs).toHaveCount(0);
  // 框里的窗口跟着框走，仍在各自的框里
  for (const w of (await deck.board()).windows) {
    const f = (await deck.board()).frames.find((x) => x.workspaceId === w.workspaceId)!.rect;
    expect(contains(f, w.rect)).toBe(true);
  }
  await deck.screenshot('frames-apart');

  // 4. 改 t2 的大小（拖右下角），让它和 t1 差不多宽：吸到同宽，标出尺寸
  // 先把 t2 整个放进视口（右下角的把手要点得到）
  await page.evaluate((id) => (window as unknown as { __board: { jumpToWindow(id: string): void } }).__board.jumpToWindow(id), t2.windowId);
  let lastVp = '';
  await expect
    .poll(
      async () => {
        const v = JSON.stringify((await deck.board()).viewport);
        const same = v === lastVp;
        lastVp = v;
        return same;
      },
      { intervals: [250] },
    )
    .toBe(true);
  const z3 = (await deck.board()).viewport.zoom;
  const a1 = await rectOf(deck, t1.windowId);
  let a2 = await rectOf(deck, t2.windowId);
  // 先拉窄 120，再拉回到只差 3
  const handle = deck.windowEl(t2.windowId).locator('.ad-window-resize--se');
  const sbox = (await handle.boundingBox())!;
  const s0 = { x: sbox.x + sbox.width / 2, y: sbox.y + sbox.height / 2 };
  await page.mouse.move(s0.x, s0.y);
  await page.mouse.down();
  await page.mouse.move(s0.x - 5, s0.y, { steps: 2 });
  await page.mouse.move(s0.x - 120 * z3, s0.y, { steps: 8 });
  // 改大小时外框跟着变，白板状态松手才写（这里量屏幕上的外框）
  const liveW = async () => Math.round(((await deck.windowEl(t2.windowId).locator('.ad-window').boundingBox())?.width ?? 0) / z3);
  await expect.poll(liveW).toBeLessThan(a2.w - 60);
  await page.mouse.move(s0.x + (a1.w - a2.w - 3) * z3, s0.y, { steps: 10 });
  await expect.poll(liveW).toBe(a1.w);
  await expect(labels(page).filter({ hasText: String(a1.w) })).not.toHaveCount(0);
  await expect(guides(page)).not.toHaveCount(0);
  await deck.screenshot('same-width');
  await page.mouse.up();
  a2 = await rectOf(deck, t2.windowId);
  // 存下来的宽度是 559.9999999999999 这样的浮点数（吸附按缩放换算时的误差），差在 1e-9 以内算同宽
  expect(a2.w).toBeCloseTo(a1.w, 6);
  expect(overlaps(a1, a2)).toBe(false);
  await expect(dialogs).toHaveCount(0);
});
