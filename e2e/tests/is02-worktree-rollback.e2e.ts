// IS-02：从界面新建 worktree 工作区。TC-01 / TC-02 的正常流程在 tc01-tc02-project-workspace；这里补 TC-02 后台预期的最后一句
// “失败时已建的 worktree 和分支回滚”：git worktree add 成功之后复制 .env 失败（读不了），worktree、分支、目录都要撤掉，框上显示错误和 Retry；
// 修好之后单击 Retry 照常建好。
import { chmodSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../support/fixtures.ts';
import { addProjectViaUi } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';
import { git } from '../support/sandbox.ts';

test('IS-02 a worktree whose .env copy fails is rolled back (worktree, branch, folder), Retry then succeeds', async ({ deck, sb }) => {
  test.skip(process.getuid?.() === 0, 'root can read a chmod 000 file, the copy would not fail');
  const repo = makeRepo(sb, 'shop', { env: 'SECRET=from-main\n' });
  const page = await deck.launch();
  // 前提：已添加项目（TC-01，真的右键 Add project…），默认会把 .env 复制进新 worktree
  const dialog = await addProjectViaUi(deck, repo);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const project = (await page.evaluate(() =>
    (window as unknown as { agentdeck: { projects: { list(): Promise<{ id: string; copyIntoWorktrees: string[]; worktreeRoot: string }[]> } } }).agentdeck.projects.list(),
  ))[0]!;
  expect(project.copyIntoWorktrees).toContain('.env');
  // .env 读不了：git worktree add 会成功，之后复制 .env 时 EACCES
  const env = join(repo, '.env');
  chmodSync(env, 0o000);
  const refsBefore = git(sb, repo, ['for-each-ref', '--format=%(refname)']);

  // 1. 右键 › New workspace… › New worktree、New branch feat/oauth from main › Create
  const at = await deck.emptyPoint();
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await deck.pickMenu(['New workspace…']);
  const nw = page.getByRole('dialog', { name: 'New workspace' });
  await expect(nw).toBeVisible();
  await expect(nw.getByRole('radio', { name: /New worktree/ })).toBeChecked();
  await expect(nw.getByRole('radio', { name: /New branch/ })).toBeChecked();
  await expect(nw.getByRole('button', { name: 'Base branch' })).toHaveText(/main/);
  await nw.getByLabel('Branch name').fill('feat/oauth');
  await nw.getByRole('button', { name: 'Create' }).click();
  await expect(nw).toBeHidden();

  // UI：先出现的框留在原地，写着错误，带 Retry / Delete；没有变成真的工作区框
  const pending = page.locator('.ad-frame--pending');
  await expect(pending.locator('.ad-frame-error')).toContainText(/EACCES|permission denied/i, { timeout: 60_000 });
  await expect(pending.locator('.ad-frame-project')).toHaveText('shop · feat/oauth');
  await expect(pending.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(deck.frameEl('feat/oauth')).toHaveCount(0);
  await deck.screenshot('create-failed');

  // 后台：回滚了——worktree 从 git worktree list 里没了，新建的分支删掉了，目录不在磁盘上，库里没有工作区
  expect(git(sb, repo, ['worktree', 'list', '--porcelain'])).not.toContain('feat/oauth');
  expect(git(sb, repo, ['branch', '--list', 'feat/oauth'])).toBe('');
  expect(git(sb, repo, ['for-each-ref', '--format=%(refname)'])).toBe(refsBefore);
  const wtRoot = project.worktreeRoot;
  expect(existsSync(join(wtRoot, 'feat-oauth'))).toBe(false);
  expect(existsSync(wtRoot) ? readdirSync(wtRoot) : []).toEqual([]);
  expect(existsSync(join(repo, '.git', 'worktrees')) ? readdirSync(join(repo, '.git', 'worktrees')) : []).toEqual([]);
  const listed = await page.evaluate(() =>
    (window as unknown as { agentdeck: { workspaces: { list(): Promise<unknown[]> } } }).agentdeck.workspaces.list(),
  );
  expect(listed).toEqual([]);
  // 主目录没被动过
  expect(git(sb, repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  expect(git(sb, repo, ['status', '--porcelain'])).toBe('');

  // 2. 修好（.env 能读了），单击 Retry：同一个框建好，.env 复制过去
  chmodSync(env, 0o644);
  await pending.getByRole('button', { name: 'Retry' }).click();
  await expect(deck.frameEl('feat/oauth')).toHaveCount(1, { timeout: 60_000 });
  await expect(pending).toHaveCount(0);
  const ws = Object.values((await deck.board()).workspaces).find((w) => w.branch === 'feat/oauth')!;
  expect(git(sb, ws.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/oauth');
  expect(git(sb, ws.path, ['rev-parse', 'HEAD'])).toBe(git(sb, repo, ['rev-parse', 'main']));
  expect(readFileSync(join(ws.path, '.env'), 'utf8')).toBe('SECRET=from-main\n');
  await deck.screenshot('retried');
});
