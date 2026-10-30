// MP2（画板“左边管理面板”MP0）：左边管理面板的 Pin（随白板保存，重开还在，拖不拖都按置顶的先后）、
// New 菜单（和右键白板同一份，新开的放在聚焦的工作区框里）、Search（只留命中的，Esc 退出）、Unpin。
import { expect, test } from '../support/fixtures.ts';
import { openManager, openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';

test('MP2 pin a terminal and a workspace (kept after a restart), New › Terminal › Shell into the focused workspace, Search and Unpin', async ({ deck, sb }) => {
  const shop = makeRepo(sb, 'shop');
  const api = makeRepo(sb, 'api');
  await deck.launch();
  const a = await setupWorktree(deck, shop, 'feat/cart');
  const b = await setupWorktree(deck, api, 'feat/pool');
  const shell = await openTerminal(deck, a.workspaceId, 'shell');
  const other = await openTerminal(deck, b.workspaceId, 'shell');
  await deck.showAll();
  const nav = await openManager(deck);
  const row = (id: string) => nav.locator(`.mgr-row[data-window-id="${id}"]`);
  await expect(row(shell.windowId)).toHaveCount(1);

  // 1. 右键 shop 的 Shell 一行 › Pin；右键 api · feat/pool 的标题 › Pin
  await row(shell.windowId).locator('.mgr-row-main').click({ button: 'right' });
  await deck.pickMenu(['Pin']);
  const pinned = nav.getByRole('region', { name: 'Pinned' });
  await expect(pinned.locator(`.mgr-row[data-window-id="${shell.windowId}"]`)).toBeVisible();
  // 置顶的那行不在下面的项目里再出现一次
  await expect(row(shell.windowId)).toHaveCount(1);
  await nav.getByRole('group', { name: 'api · feat/pool' }).locator('.mgr-path-row').click({ button: 'right' });
  await deck.pickMenu(['Pin']);
  await expect(pinned.locator('.mgr-row')).toHaveCount(2);
  await expect(pinned.getByRole('button', { name: 'api · feat/pool' })).toBeVisible();
  await expect.poll(async () => (await deck.board()).pins.length).toBe(2);
  await deck.screenshot('pinned');

  // 2. 重开应用：置顶还在，顺序不变
  await deck.quit();
  await deck.launch();
  const again = await openManager(deck);
  const pinnedAgain = again.getByRole('region', { name: 'Pinned' });
  await expect(pinnedAgain.locator('.mgr-row')).toHaveCount(2);
  expect(await pinnedAgain.locator('.mgr-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))).toEqual([
    expect.stringMatching(/^window:/),
    `workspace:${b.workspaceId}`,
  ]);

  // 3. 单击置顶的工作路径：选中那个框
  await pinnedAgain.getByRole('button', { name: 'api · feat/pool' }).click();
  await expect.poll(async () => (await deck.board()).selectedFrame).toBe(b.workspaceId);

  // 4. 单击置顶的 Shell 一行：跳过去并聚焦；New › Terminal › Shell：新终端在 shop · feat/cart 的框里，并聚焦它
  await pinnedAgain.locator(`.mgr-row[data-window-id="${shell.windowId}"] .mgr-row-main`).click();
  await expect.poll(async () => (await deck.board()).focusedId).toBe(shell.windowId);
  const before = (await deck.board()).windows.length;
  await again.getByRole('button', { name: 'New' }).click();
  await expect(deck.page.getByRole('menu').getByText('NEW')).toBeVisible();
  await deck.pickMenu(['Terminal', 'Shell']);
  await expect.poll(async () => (await deck.board()).windows.length).toBe(before + 1);
  const board = await deck.board();
  const added = board.windows[board.windows.length - 1]!;
  expect(added.workspaceId).toBe(a.workspaceId);
  await expect.poll(async () => (await deck.board()).focusedId).toBe(added.id);
  await expect(again.getByRole('group', { name: 'shop · feat/cart' }).locator(`.mgr-row[data-window-id="${added.id}"]`)).toBeVisible();

  // 5. Search：只留命中的（按分支找），Esc 退出
  await again.getByRole('button', { name: 'Search' }).click();
  const box = again.getByRole('searchbox', { name: 'Search' });
  await expect(box).toBeFocused();
  await box.fill('feat/pool');
  await expect(again.locator(`.mgr-row[data-window-id="${other.windowId}"]`)).toBeVisible();
  await expect(again.locator(`.mgr-row[data-window-id="${added.id}"]`)).toHaveCount(0);
  await deck.screenshot('search');
  await box.press('Escape');
  await expect(box).toHaveCount(0);
  await expect(again.locator(`.mgr-row[data-window-id="${added.id}"]`)).toBeVisible();

  // 6. 右键置顶的工作路径 › Unpin
  await pinnedAgain.getByRole('button', { name: 'api · feat/pool' }).click({ button: 'right' });
  await deck.pickMenu(['Unpin']);
  await expect(pinnedAgain.locator('.mgr-row')).toHaveCount(1);
  await expect.poll(async () => (await deck.board()).pins.length).toBe(1);
});
