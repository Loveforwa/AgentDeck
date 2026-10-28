// TC-36 面板里的提交图（N5）：泳道、分叉和合并弧线、分支标签；白板上在用的分支带框名；已合并又不在白板上的分支收成一行；
// All branches / This workspace；点提交展开改的文件。
// 用例前提写的是 agenduck 仓库；这里用沙盒里的测试仓库搭出同样的形状（多个分支、合并过的分支、白板上的 worktree），
// 不碰 agenduck 本身。大仓库的性能不在这里看。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';
import { git } from '../support/sandbox.ts';

test('TC-36 commit graph: lanes, merges, labels with frames, merged branches collapsed, view switch, commit files', async ({ deck, sb }) => {
  // feat/cart、feat/old：合并进 main 的分支（不在白板上）
  const repo = makeRepo(sb, 'shop', { branches: { 'feat/cart': { 'cart.txt': 'cart\n' }, 'feat/old': { 'old.txt': 'old\n' } } });
  // feat/search：没合并、不在白板上
  git(sb, repo, ['switch', '-q', '-c', 'feat/search']);
  writeFileSync(join(repo, 'search.txt'), 'search\n');
  git(sb, repo, ['add', '-A']);
  git(sb, repo, ['commit', '-q', '-m', 'Add search']);
  git(sb, repo, ['switch', '-q', 'main']);
  const page = await deck.launch();
  // feat/login：白板上有它的框，有一次自己的提交（从 main 分叉）
  const login = await setupWorktree(deck, repo, 'feat/login');
  writeFileSync(join(login.path, 'login.txt'), 'login\n');
  git(sb, login.path, ['add', '-A']);
  git(sb, login.path, ['commit', '-q', '-m', 'Add login form']);
  // main 上再提交一次：feat/login、feat/search 都和 main 分叉了
  writeFileSync(join(repo, 'src/app.txt'), 'hello\nworld\nagain\n');
  git(sb, repo, ['commit', '-q', '-am', 'Polish app']);
  // 主目录工作区（main），框里一个 Shell
  const mainWs = await page.evaluate(async (projectId) => {
    const b = (window as unknown as { __board: { createWorkspace(req: object, at: null): Promise<string | null> } }).__board;
    return b.createWorkspace({ projectId, mode: 'main-folder' }, null);
  }, login.projectId);
  if (!mainWs) throw new Error('could not create the main-folder workspace');
  const shell = await openTerminal(deck, mainWs, 'shell');
  await deck.showAll();
  await deck.focusWindow(shell.windowId);

  const panel = page.getByRole('complementary', { name: 'Source Control' });
  await expect(panel.getByRole('button', { name: /^Branch main\. Switch branch/ })).toBeVisible();
  // 1. 看右侧面板的 Graph 区
  const graph = panel.getByRole('region', { name: 'Commit graph' });
  await expect(graph).toBeVisible();
  // 2. 切到 All branches
  const viewButton = graph.locator('.scm-graph-view');
  if (!/All branches/.test((await viewButton.textContent()) ?? '')) {
    await viewButton.click();
    await page.getByRole('menu', { name: 'Graph view' }).getByRole('menuitemcheckbox', { name: 'All branches' }).click();
  }
  await expect(viewButton).toHaveAccessibleName('Show: All branches');
  const rows = graph.locator('.scm-graph-rows > [role="listitem"]');
  const labels = graph.locator('.scm-graph-rows .scm-graph-label');

  // UI：分支标签：HEAD → main、feat/login 带 ◧（白板上有它的框，单击能跳过去）、feat/search
  await expect(labels.filter({ hasText: /^HEAD → main/ })).toHaveCount(1);
  const loginLabel = labels.filter({ hasText: /^feat\/login/ });
  await expect(loginLabel).toHaveCount(1);
  await expect(loginLabel.locator('.scm-graph-frame')).toHaveText('◧');
  await expect(loginLabel).toHaveAttribute('data-board', 'true');
  await expect(labels.filter({ hasText: /^feat\/search$/ })).toHaveCount(1);
  // UI：已合并又不在白板上的 feat/cart、feat/old 收成一行，Show 展开
  await expect(labels.filter({ hasText: /^feat\/(cart|old)/ })).toHaveCount(0);
  const merged = graph.locator('.scm-graph-merged-toggle');
  await expect(merged).toContainText('2 merged branches not on the board');
  await expect(merged).toContainText('Show');
  // UI：泳道（不止一条）、分叉和合并的弧线（贝塞尔曲线）、合并提交是空心双圈
  const lanes = await graph.locator('.scm-graph-cell circle.scm-graph-node, .scm-graph-cell circle[data-head]').evaluateAll((cs) =>
    [...new Set(cs.map((c) => c.getAttribute('cx')))].length,
  );
  expect(lanes).toBeGreaterThan(1);
  expect(await graph.locator('.scm-graph-cell path.scm-graph-line').evaluateAll((ps) => ps.filter((p) => (p.getAttribute('d') ?? '').includes('C')).length)).toBeGreaterThan(0);
  const mergeRow = rows.filter({ hasText: 'Merge feat/cart' });
  await expect(mergeRow.locator('circle.scm-graph-node')).toHaveCount(1);
  await expect(mergeRow.locator('circle.scm-graph-dot')).toHaveCount(1);
  // 后台：每个提交一行，和 git 一致
  const allCount = Number(git(sb, repo, ['rev-list', '--all', '--count']));
  await expect(rows).toHaveCount(allCount);
  await deck.screenshot('all-branches');

  await merged.click();
  const mergedList = graph.getByRole('list', { name: 'Merged branches' });
  await expect(mergedList.getByRole('listitem')).toHaveText([/feat\/cart/, /feat\/old/]);
  await expect(merged).toContainText('Hide');

  // 3. 点一个提交（Merge feat/cart）：展开它改的文件 cart.txt
  await mergeRow.locator('.scm-graph-main').click();
  await expect(mergeRow.locator('.scm-graph-main')).toHaveAttribute('aria-expanded', 'true');
  const short = git(sb, repo, ['log', '--format=%h', '--grep=^Merge feat/cart$', '-1']);
  const files = graph.getByLabel(`Files in ${short}`);
  await expect(files.locator('.scm-graph-file')).toHaveText([/cart\.txt/]);
  await deck.screenshot('commit-files');

  // 2'. 切到 This workspace：只剩 main 这条线（别的分支的标签、提交都不在了）
  await viewButton.click();
  await page.getByRole('menu', { name: 'Graph view' }).getByRole('menuitemcheckbox', { name: 'This workspace' }).click();
  await expect(viewButton).toHaveAccessibleName('Show: This workspace');
  await expect(labels.filter({ hasText: /^feat\/(login|search)/ })).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Add login form' })).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Add search' })).toHaveCount(0);
  await expect(rows).toHaveCount(Number(git(sb, repo, ['rev-list', '--count', 'main'])));
  await deck.screenshot('this-workspace');

  // feat/login 的标签单击跳到它的框（白板上在用的分支）
  await viewButton.click();
  await page.getByRole('menu', { name: 'Graph view' }).getByRole('menuitemcheckbox', { name: 'All branches' }).click();
  await labels.filter({ hasText: /^feat\/login/ }).click();
  await expect.poll(async () => (await deck.board()).selectedFrame).toBe(login.workspaceId);
});
