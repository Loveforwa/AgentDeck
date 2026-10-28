// TC-15 修改项目设置：基础分支、复制的文件、初始化命令（白板里的 Settings 对话框，X12）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../support/fixtures.ts';
import { createWorktreeInDialog } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';
import { git } from '../support/sandbox.ts';

test('TC-15 project settings: change base branch, files to copy, setup command; a new workspace uses them', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  // 一个没合进 main 的分支（新工作区从它分出时能看出来）、一个不进 git 的本地文件（复制的文件）
  git(sb, repo, ['switch', '-q', '-c', 'feat/search']);
  writeFileSync(join(repo, 'search.txt'), 'search\n');
  git(sb, repo, ['add', '-A']);
  git(sb, repo, ['commit', '-q', '-m', 'Add search']);
  git(sb, repo, ['switch', '-q', 'main']);
  mkdirSync(join(repo, 'config'));
  writeFileSync(join(repo, 'config/local.json'), '{"local":true}\n');
  const worktreeRoot = join(sb.root, 'custom-worktrees');
  const page = await deck.launch();
  // 前提：已添加项目（别的项目也在，看对话框选中的是哪个）
  const other = makeRepo(sb, 'api');
  const projectId = await page.evaluate(
    async ({ repo, other }) => {
      const w = window as unknown as {
        agentdeck: { projects: { add(r: { folder: string; as: string }): Promise<{ id: string }[]> } };
        __board: { refreshProjects(): Promise<void> };
      };
      await w.agentdeck.projects.add({ folder: other, as: 'git' });
      const p = (await w.agentdeck.projects.add({ folder: repo, as: 'git' }))[0]!;
      await w.__board.refreshProjects();
      return p.id;
    },
    { repo, other },
  );

  // 1. 顶栏 Projects ▾ › shop › Project settings…
  await page.locator('.ad-topbar-project').click();
  await deck.pickMenu(['shop', 'Project settings…']);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('navigation', { name: 'Settings sections' }).locator('[aria-current="page"]')).toContainText('shop');

  // UI：能看到名称、路径、基础分支、worktree 位置、复制的文件、初始化命令
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('shop');
  await expect(dialog.locator('.ad-settings-path')).toHaveText(repo);
  const base = dialog.getByRole('button', { name: 'Base branch' });
  await expect(base).toHaveText(/main/);
  await expect(dialog.getByRole('textbox', { name: 'Worktree location' })).not.toHaveValue('');
  await expect(dialog.getByRole('textbox', { name: 'Files to copy' })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Setup command' })).toBeVisible();
  await deck.screenshot('settings-before');

  // 2. 改名称、基础分支、worktree 位置、复制的文件、初始化命令
  await dialog.getByRole('textbox', { name: 'Name' }).fill('shop-web');
  await base.click();
  await page.getByRole('menu', { name: 'Base branch' }).getByRole('menuitemcheckbox', { name: 'feat/search' }).click();
  await expect(base).toHaveText(/feat\/search/);
  await dialog.getByRole('textbox', { name: 'Worktree location' }).fill(worktreeRoot);
  await dialog.getByRole('textbox', { name: 'Files to copy' }).fill('.env\nconfig/local.json');
  await dialog.getByRole('textbox', { name: 'Setup command' }).fill('echo setup-ran > SETUP_OK.txt');
  await deck.screenshot('settings-edited');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  // 后台：设置写进 store
  const saved = await page.evaluate(
    async (id) =>
      (
        await (window as unknown as { agentdeck: { projects: { list(): Promise<Record<string, unknown>[]> } } }).agentdeck.projects.list()
      ).find((p) => p['id'] === id),
    projectId,
  );
  expect(saved).toEqual(
    expect.objectContaining({
      name: 'shop-web',
      path: repo,
      setupCommand: 'echo setup-ran > SETUP_OK.txt',
      repos: [expect.objectContaining({ baseBranch: 'feat/search' })],
    }),
  );
  expect(JSON.stringify(saved)).toContain(worktreeRoot);
  expect(JSON.stringify(saved)).toContain('config/local.json');
  // 重新打开：改过的值都在
  await page.locator('.ad-topbar-project').click();
  await deck.pickMenu(['shop-web', 'Project settings…']);
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('shop-web');
  await expect(dialog.getByRole('button', { name: 'Base branch' })).toHaveText(/feat\/search/);
  await expect(dialog.getByRole('textbox', { name: 'Worktree location' })).toHaveValue(worktreeRoot);
  await expect(dialog.getByRole('textbox', { name: 'Files to copy' })).toHaveValue('.env\nconfig/local.json');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // 3. 新建一个工作区验证：Projects ▾ › shop-web › New workspace…，基础分支默认是 feat/search
  await page.locator('.ad-topbar-project').click();
  await deck.pickMenu(['shop-web', 'New workspace…']);
  const nw = page.getByRole('dialog', { name: 'New workspace' });
  await expect(nw.getByRole('button', { name: 'Project' })).toHaveText(/shop-web/);
  await expect(nw.getByRole('button', { name: 'Base branch' })).toHaveText(/feat\/search/);
  const wsId = await createWorktreeInDialog(deck, 'feat/settings-check');
  await expect(deck.frameEl('feat/settings-check').locator('.ad-frame-project')).toHaveText('shop-web');
  const ws = (await deck.board()).workspaces[wsId]!;

  // 后台：worktree 在新位置，从 feat/search 分出，复制了 .env 和 config/local.json，框里的 setup Shell 跑了初始化命令
  expect(ws.path.startsWith(`${worktreeRoot}/`)).toBe(true);
  expect(git(sb, ws.path, ['rev-parse', 'HEAD'])).toBe(git(sb, repo, ['rev-parse', 'feat/search']));
  expect(existsSync(join(ws.path, 'search.txt'))).toBe(true);
  expect(readFileSync(join(ws.path, '.env'), 'utf8')).toBe('SECRET=e2e\n');
  expect(readFileSync(join(ws.path, 'config/local.json'), 'utf8')).toBe('{"local":true}\n');
  await deck.waitForWindow((w) => w.workspaceId === wsId && w.type === 'terminal' && w.title === 'setup');
  await expect.poll(() => existsSync(join(ws.path, 'SETUP_OK.txt')), { timeout: 30_000 }).toBe(true);
  await deck.showAll();
  await deck.screenshot('workspace-from-settings');
});
