// TC-07 在右侧面板里提交 agent 改的代码；TC-12 删除工作区，连目录一起删。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';
import { git } from '../support/sandbox.ts';

test('TC-07 stage two files from the panel and commit with ⌘↩', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  // 前提：测试分支的工作区里有几个改动的文件（像 agent 改过）
  const { workspaceId, path } = await setupWorktree(deck, repo, 'feat/commit');
  writeFileSync(join(path, 'src/app.txt'), 'hello\nworld\nfrom the agent\n');
  writeFileSync(join(path, 'notes.md'), '# Notes\n');
  mkdirSync(join(path, 'docs'));
  writeFileSync(join(path, 'docs/guide.md'), '# Guide\n');
  const shell = await openTerminal(deck, workspaceId, 'shell');
  await deck.showAll();

  // 1. 聚焦那个工作区里的终端：面板显示这个分支的更改，按文件夹树形排列
  await deck.focusWindow(shell.windowId);
  const panel = page.getByRole('complementary', { name: 'Source Control' });
  await expect(panel.getByRole('button', { name: /^Branch feat\/commit\. Switch branch/ })).toBeVisible();
  const changes = panel.getByRole('region', { name: 'Changes', exact: true });
  await expect(changes.locator('.scm-row--folder .scm-name')).toContainText(['docs', 'src']);
  await expect(changes.locator('.scm-row--file')).toHaveCount(3);
  await deck.screenshot('changes');

  // 2. 悬停文件，单击 + 暂存两个。每暂存一个，上面多出 Staged Changes、列表往下挪：等它挪完再悬停下一个，
  // 不然鼠标落在挪过来的别的行上，按钮一直不出来（CI 的机器慢，每次都碰上）
  const staged = panel.getByRole('region', { name: 'Staged Changes', exact: true });
  for (const [i, name] of ['notes.md', 'app.txt'].entries()) {
    const row = changes.locator('.scm-row--file', { has: page.locator('.scm-name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }) });
    await row.hover();
    await row.getByRole('button', { name: `Stage ${name}` }).click();
    await expect(staged.locator('.scm-row--file')).toHaveCount(i + 1);
  }
  await expect(staged.locator('.scm-row--file')).toHaveCount(2);
  await expect(changes.locator('.scm-row--file')).toHaveCount(1);
  // 后台：git add 在这个 worktree 里执行了
  expect(git(sb, path, ['status', '--porcelain']).split('\n').sort()).toEqual(['?? docs/', 'A  notes.md', 'M  src/app.txt']);

  // 3. 写提交信息，按 ⌘↩
  const message = panel.getByRole('textbox', { name: 'Commit message' });
  await message.click();
  await message.fill('Add notes and greet from the agent');
  await page.keyboard.press('Meta+Enter');

  // UI：Staged Changes 清空，剩下没暂存的那个；提交记录顶部出现这一条
  await expect(staged).toHaveCount(0);
  await expect(changes.locator('.scm-row--file')).toHaveCount(1);
  await expect(panel.locator('.scm-graph-subject').first()).toHaveText('Add notes and greet from the agent');
  await deck.screenshot('committed');
  // 后台：提交在 feat/commit 上（不是 main），只带了暂存的两个文件
  expect(git(sb, path, ['log', '-1', '--format=%s'])).toBe('Add notes and greet from the agent');
  expect(git(sb, path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/commit');
  expect(git(sb, path, ['show', '--name-only', '--format=', 'HEAD']).split('\n').sort()).toEqual(['notes.md', 'src/app.txt']);
  expect(git(sb, repo, ['log', '-1', '--format=%s', 'main'])).not.toBe('Add notes and greet from the agent');
  expect(git(sb, path, ['status', '--porcelain'])).toBe('?? docs/');
});

test('TC-12 delete a worktree workspace and its folder; uncommitted changes need a second confirmation', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  // 前提：一个 worktree 工作区，里面有一个未提交的改动；框里开着一个 Shell
  const { workspaceId, path } = await setupWorktree(deck, repo, 'feat/delete');
  writeFileSync(join(path, 'src/app.txt'), 'unsaved work\n');
  const shell = await openTerminal(deck, workspaceId, 'shell');
  await deck.showAll();

  // 1. 右键框 › Delete workspace…
  await deck.frameEl('feat/delete').locator('.ad-frame-header').click({ button: 'right', position: { x: 40, y: 12 } });
  await deck.pickMenu(['Delete workspace…']);
  const dialog = page.getByRole('dialog', { name: /^Delete workspace/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('will be stopped');

  // 2. 选 Also delete the worktree folder
  // 单选框本身是隐藏的原生 input，像用户一样点文字
  await dialog.getByText('Also delete the worktree folder').click();
  await expect(dialog.getByRole('radio', { name: /Also delete the worktree folder/ })).toBeChecked();
  // 3. 确认；看到“有未提交的更改”再确认一次
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog).toContainText('Uncommitted changes in this worktree will be lost');
  await expect(dialog.getByRole('button', { name: 'Delete' })).toBeDisabled();
  // 后台：第一次确认什么也没删
  expect(existsSync(path)).toBe(true);
  await deck.screenshot('uncommitted-warning');
  await dialog.getByText('I understand these changes will be lost').click();
  await expect(dialog.getByRole('checkbox', { name: /I understand these changes will be lost/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Delete' }).click();

  // UI：完成后框从白板消失
  await expect(dialog).toBeHidden();
  await expect(deck.frameEl('feat/delete')).toHaveCount(0);
  await expect.poll(async () => (await deck.board()).windows.length).toBe(0);
  await deck.screenshot('deleted');

  // 后台：git worktree remove --force；目录从磁盘消失，分支保留；框里的终端结束了
  await expect.poll(() => existsSync(path)).toBe(false);
  expect(git(sb, repo, ['worktree', 'list', '--porcelain'])).not.toContain(path);
  expect(git(sb, repo, ['branch', '--list', 'feat/delete'])).toContain('feat/delete');
  await expect.poll(() => sb.tmux(['has-session', '-t', `=${shell.terminalId}`]).status).not.toBe(0);
  expect(Object.values((await deck.board()).workspaces).some((w) => w.id === workspaceId)).toBe(false);
});
