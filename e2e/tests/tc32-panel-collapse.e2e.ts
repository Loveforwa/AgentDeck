// TC-32（V4）右侧面板能收起再展开：标题栏 ⇥ 收起成 28px 竖条（⇤ 展开、分支图标、有改动时黄点），白板变宽；
// 展开恢复；重启后保持；⌘B 也能切换。后台：状态存在 BoardState.panel（board.load 读回来）。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';

/** 白板露出来的宽度：面板浮在白板上，从白板左边到面板（或竖条）左边。 */
const paneWidth = async (deck: Deck) => {
  const pane = await deck.page.locator('.react-flow__pane').boundingBox();
  const side = await deck.page.locator('aside.ad-panel, aside.ad-panel-rail').first().boundingBox();
  return pane && side ? side.x - pane.x : 0;
};
const savedPanel = (deck: Deck) =>
  deck.page.evaluate(async () => (await (window as unknown as { agentdeck: { board: { load(): Promise<{ panel?: { open: boolean } }> } } }).agentdeck.board.load()).panel ?? null);

test('TC-32 collapse the side panel to a rail, expand it, it stays collapsed after a restart, ⌘B toggles', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'api');
  const page = await deck.launch();
  // 前提：白板上有一个工作区，里面有未提交的改动（看竖条上的黄点）
  const { workspaceId, path } = await setupWorktree(deck, repo, 'feat/rail');
  const t = await openTerminal(deck, workspaceId, 'shell');
  writeFileSync(join(path, 'src/app.txt'), 'hello\nworld\nchanged\n');
  await deck.showAll();
  await deck.focusWindow(t.windowId);
  const panel = page.locator('aside.ad-panel');
  const rail = page.getByRole('complementary', { name: 'Side panel (collapsed)' });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Source Control' })).toContainText('feat/rail');
  const wide = await paneWidth(deck);
  const panelWidth = (await panel.boundingBox())!.width;
  await deck.screenshot('open');

  // 1. 点面板标题栏右边的 ⇥
  await panel.getByRole('button', { name: 'Collapse panel' }).click();
  await expect(rail).toBeVisible();
  await expect(panel).toHaveCount(0);
  // UI：28px 竖条：展开按钮、分支图标、有改动时一个黄点（--status-waiting）
  expect(Math.round((await rail.boundingBox())!.width)).toBe(28);
  await expect(rail.getByRole('button', { name: 'Expand panel' })).toBeVisible();
  await expect(rail.locator('.ad-panel-rail-branch')).toBeVisible();
  await expect(rail.locator('.ad-panel-rail-branch')).toHaveAttribute('title', /feat\/rail/);
  const dot = rail.getByRole('img', { name: 'Uncommitted changes' });
  await expect(dot).toBeVisible();
  const waitingColor = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--status-waiting)';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  });
  expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(waitingColor);
  // 白板变宽
  await expect.poll(() => paneWidth(deck)).toBeGreaterThan(wide + panelWidth - 40);
  // 后台：存进 BoardState.panel
  await expect.poll(() => savedPanel(deck)).toMatchObject({ open: false });
  await deck.screenshot('collapsed');

  // 2. 点竖条上的 ⇤：展开恢复（宽度不变）
  await rail.getByRole('button', { name: 'Expand panel' }).click();
  await expect(panel).toBeVisible();
  await expect(rail).toHaveCount(0);
  expect(Math.round((await panel.boundingBox())!.width)).toBe(Math.round(panelWidth));
  await expect.poll(() => paneWidth(deck)).toBeCloseTo(wide, 0);

  await expect.poll(() => savedPanel(deck)).toMatchObject({ open: true });

  // ⌘B 也能切换（焦点在白板上、在终端里都行：终端把 ⌘ 组合键交给白板）
  await page.keyboard.press('Meta+B');
  await expect(rail).toBeVisible();
  await page.keyboard.press('Meta+B');
  await expect(panel).toBeVisible();

  // 3. 收起后退出再打开应用：仍是收起
  await panel.getByRole('button', { name: 'Collapse panel' }).click();
  await expect(rail).toBeVisible();
  await expect.poll(() => savedPanel(deck)).toMatchObject({ open: false });
  await deck.quit();
  await deck.launch();
  const rail2 = deck.page.getByRole('complementary', { name: 'Side panel (collapsed)' });
  await expect(rail2).toBeVisible();
  await expect(deck.page.locator('aside.ad-panel')).toHaveCount(0);
  expect(Math.round((await rail2.boundingBox())!.width)).toBe(28);
  await deck.screenshot('after-restart');
  // ⌘B 展开
  await deck.page.keyboard.press('Meta+B');
  await expect(deck.page.locator('aside.ad-panel')).toBeVisible();
  await expect.poll(() => savedPanel(deck)).toMatchObject({ open: true });
});
