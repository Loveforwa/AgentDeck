// TC-29（V1）顶栏只有一行：系统的红黄绿按钮和顶栏同一行（hiddenInset，按钮位置由主进程定）；左边项目菜单和当前工作区，
// 菜单里有各项目（子菜单 New workspace…）、Add project…；右边状态灯和齿轮，齿轮打开 Settings；框、面板、窗口、菜单、对话框都是圆角（tokens）。
// 系统按钮本身画在网页外面，截图里看不到；这里核对主进程给的按钮位置和顶栏留的位置（用户 2026-10-25 在真窗口里看过同一行）。
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';

const radius = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
const token = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('TC-29 one-row top bar: project menu and workspace on the left, lamps and Settings gear on the right, rounded corners', async ({ deck, sb }) => {
  const api = makeRepo(sb, 'api');
  const shop = makeRepo(sb, 'shop');
  const page = await deck.launch();
  await setupWorktree(deck, api, 'feat/top');
  const ws = await setupWorktree(deck, shop, 'feat/cart');
  const shell = await openTerminal(deck, ws.workspaceId, 'shell');
  const claude = await openFakeClaude(deck, ws.workspaceId);
  await deck.showAll();
  await deck.focusWindow(claude.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(claude.terminalId, 'running');
  await deck.focusWindow(shell.windowId);

  // 1. 看应用顶部
  const bar = page.locator('header.ad-topbar');
  await expect(bar).toHaveCount(1);
  const box = (await bar.boundingBox())!;
  expect(box.y).toBe(0);
  expect(box.height).toBe(34);
  // 顶栏里的东西都在这一行（竖直方向都在 0–34 里）
  for (const el of await bar.locator('button, .ad-topbar-summary, .ad-topbar-count').all()) {
    const b = (await el.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height).toBeLessThanOrEqual(34);
  }
  // 后台：macOS 上是 hiddenInset 标题栏，红黄绿按钮放在这一行里、竖直居中（14, 9：按钮那一排高 16），顶栏左边给它们留 76px
  if (process.platform === 'darwin') {
    const pos = await deck.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]! as unknown as { getWindowButtonPosition(): { x: number; y: number } | null };
      return w.getWindowButtonPosition();
    });
    expect(pos).toEqual({ x: 14, y: 9 });
    expect(pos!.y * 2 + 16).toBe(34);
    await expect(bar).toHaveClass(/ad-topbar--traffic-lights/);
    expect(await bar.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('76px');
    const first = (await bar.locator('button').first().boundingBox())!;
    expect(first.x).toBeGreaterThanOrEqual(76);
  }
  // 左边：项目菜单（聚焦窗口所在的项目）和当前工作区；右边：状态灯和齿轮
  const project = bar.getByRole('button', { name: /shop/ });
  await expect(project).toBeVisible();
  await expect(bar.locator('.ad-topbar-summary')).toHaveText('feat/cart · 2 windows');
  await expect(bar.locator('.ad-topbar-count--running')).toContainText('1 running');
  const gear = bar.getByRole('button', { name: 'Settings' });
  const p = (await project.boundingBox())!;
  const g = (await gear.boundingBox())!;
  const lamp = (await bar.locator('.ad-topbar-count--running').boundingBox())!;
  expect(p.x).toBeLessThan(box.width / 3);
  expect(g.x + g.width).toBeGreaterThan(box.width - 60);
  expect(lamp.x).toBeGreaterThan(box.width / 2);
  expect(lamp.x).toBeLessThan(g.x);
  await deck.screenshot('topbar');

  // 2. 点左边的项目菜单：各项目（子菜单 New workspace…、Project settings…），Add project…
  await project.click();
  const menu = page.getByRole('menu', { name: 'Projects' });
  await expect(menu).toBeVisible();
  const items = (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim());
  expect(items[items.length - 1]).toBe('Add project…');
  expect(items.slice(0, -1).sort()).toEqual(['api', 'shop']);
  await menu.getByRole('menuitem', { name: /^shop/ }).hover();
  await menu.getByRole('menuitem', { name: /^shop/ }).click();
  const sub = page.getByRole('menu').last();
  await expect(sub.getByRole('menuitem', { name: /^New workspace…/ })).toBeVisible();
  await expect(sub.getByRole('menuitem', { name: /^Project settings…/ })).toBeVisible();
  // 圆角：菜单 8
  expect(await radius(page, '.ad-menu')).toBe(await token(page, '--radius-menu'));
  expect(await token(page, '--radius-menu')).toBe('8px');
  await deck.screenshot('projects-menu');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // 3. 点右边的齿轮：打开 Settings，停在当前项目（shop，IS-71）
  await gear.click();
  const dialog = page.getByRole('dialog', { name: /Settings/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('navigation', { name: 'Settings sections' }).locator('[aria-current="page"]')).toHaveText('shop');
  expect(await radius(page, '.ad-dialog')).toBe('8px');
  await deck.screenshot('settings');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  // 框 12、面板 10、窗口 8，都来自 design-tokens（组件里写的是 var(--radius-*)）
  expect(await radius(page, '.ad-frame')).toBe('12px');
  expect(await radius(page, 'aside.ad-panel')).toBe('10px');
  expect(await radius(page, '.ad-window')).toBe('8px');
  expect(await token(page, '--radius-frame')).toBe('12px');
  expect(await token(page, '--radius-panel')).toBe('10px');
  expect(await token(page, '--radius-window')).toBe('8px');
});
