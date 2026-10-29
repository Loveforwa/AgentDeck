// TC-23 在面板里暂存再取消暂存一个文件；TC-24 在面板里给“主目录工作区”切换分支（目录里有终端开着就先确认）。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';
import { git } from '../support/sandbox.ts';

function fileRow(deck: Deck, region: ReturnType<Deck['page']['getByRole']>, name: string) {
  return region.locator('.scm-row--file', { has: deck.page.locator('.scm-name', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) });
}

test('TC-23 stage and unstage a file from the panel; git status follows', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  // 前提：工作区里有改动：一个新文件、一个改过的已跟踪文件
  const { workspaceId, path } = await setupWorktree(deck, repo, 'feat/stage');
  writeFileSync(join(path, 'SETUP_OK.txt'), 'setup-ran\n');
  writeFileSync(join(path, 'src/app.txt'), 'hello\nworld\nchanged\n');
  const shell = await openTerminal(deck, workspaceId, 'shell');
  await deck.showAll();
  await deck.focusWindow(shell.windowId);

  const panel = page.getByRole('complementary', { name: 'Source Control' });
  const changes = panel.getByRole('region', { name: 'Changes', exact: true });
  const staged = panel.getByRole('region', { name: 'Staged Changes', exact: true });
  await expect(changes.locator('.scm-row--file')).toHaveCount(2);
  await expect(staged).toHaveCount(0);
  // 不用 git()：它会 trim 掉第一行开头的空格（' M'）
  const status = () =>
    execFileSync('git', ['status', '--porcelain'], { cwd: path, env: sb.env, encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  expect(status()).toEqual([' M src/app.txt', '?? SETUP_OK.txt']);

  for (const [name, stagedCode, back] of [
    ['SETUP_OK.txt', 'A  SETUP_OK.txt', '?? SETUP_OK.txt'],
    ['app.txt', 'M  src/app.txt', ' M src/app.txt'],
  ] as const) {
    const other = status().filter((l) => !l.endsWith(name));
    // 1. 悬停文件，单击 +：移到 Staged Changes
    const row = fileRow(deck, changes, name);
    await row.hover();
    await row.getByRole('button', { name: `Stage ${name}` }).click();
    await expect(fileRow(deck, staged, name)).toHaveCount(1);
    await expect(fileRow(deck, changes, name)).toHaveCount(0);
    // 后台：git add；git status 和界面一致
    expect(status()).toEqual([...other, stagedCode].sort());
    await deck.screenshot(`staged-${name}`);

    // 2. 再单击 −：回到 Changes
    const srow = fileRow(deck, staged, name);
    await srow.hover();
    await srow.getByRole('button', { name: `Unstage ${name}` }).click();
    await expect(fileRow(deck, changes, name)).toHaveCount(1);
    await expect(staged).toHaveCount(0);
    // 后台：git restore --staged（新文件变回 ??，改过的变回没暂存的 M）
    expect(status()).toEqual([...other, back].sort());
  }
  await deck.screenshot('unstaged');
});

test('TC-24 switching the main-folder workspace branch asks first when terminals are open there', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  // 另一个分支：多一个文件（切过去目录里的文件真的会变）
  git(sb, repo, ['switch', '-q', '-c', 'feat/other']);
  writeFileSync(join(repo, 'other.txt'), 'only on feat/other\n');
  git(sb, repo, ['add', '-A']);
  git(sb, repo, ['commit', '-q', '-m', 'Work on feat/other']);
  git(sb, repo, ['switch', '-q', 'main']);
  const page = await deck.launch();

  // 前提：项目的主目录工作区，框里开着终端：一个空闲的 Shell、一个空闲的 claude
  const workspaceId = await page.evaluate(async (repo) => {
    const w = window as unknown as {
      agentdeck: { projects: { add(r: { folder: string; as: string }): Promise<{ id: string }[]> } };
      __board: { refreshProjects(): Promise<void>; createWorkspace(req: object, at: null): Promise<string | null> };
    };
    const project = (await w.agentdeck.projects.add({ folder: repo, as: 'git' }))[0]!;
    await w.__board.refreshProjects();
    return w.__board.createWorkspace({ projectId: project.id, mode: 'main-folder' }, null);
  }, repo);
  if (!workspaceId) throw new Error('could not create the main-folder workspace');
  expect((await deck.board()).workspaces[workspaceId]).toEqual(expect.objectContaining({ mode: 'main-folder', path: repo, branch: 'main' }));
  const shell = await openTerminal(deck, workspaceId, 'shell');
  const claude = await openFakeClaude(deck, workspaceId);
  await deck.showAll();
  // 记下 workspace.changed 事件
  await page.evaluate(() => {
    const w = window as unknown as { agentdeck: { on(t: string, l: (e: unknown) => void): void }; __e2eWsChanged: unknown[] };
    w.__e2eWsChanged = [];
    w.agentdeck.on('workspace.changed', (e) => w.__e2eWsChanged.push(e));
  });
  const wsChanged = () =>
    page.evaluate(() => (window as unknown as { __e2eWsChanged: { workspace: { id: string; branch: string | null } }[] }).__e2eWsChanged);

  // 1. 聚焦框里的终端
  await deck.focusWindow(shell.windowId);
  const panel = page.getByRole('complementary', { name: 'Source Control' });
  const branchButton = panel.getByRole('button', { name: /^Branch main\. Switch branch/ });
  // 2. 面板里单击分支按钮；3. 单击另一个分支
  const pick = async () => {
    await panel.getByRole('button', { name: /^Branch main\. Switch branch/ }).click();
    const picker = page.getByRole('dialog', { name: 'Switch branch' });
    await picker.getByRole('option', { name: /feat\/other/ }).click();
    await expect(picker).toBeHidden();
  };
  await pick();

  // UI：先弹确认，写明哪些终端在这个目录里、它们看到的文件会变
  const confirm = page.getByRole('dialog', { name: 'Switch to feat/other?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('bash and claude are open in this folder. Switching branches changes the files they see.');
  await deck.screenshot('confirm');
  // 后台：确认之前没有 git switch
  expect(git(sb, repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');

  // Cancel：什么也不变
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(branchButton).toBeVisible();
  expect(git(sb, repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  expect(await wsChanged()).toEqual([]);

  // 再来一次，这次确认
  await pick();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(confirm).toBeHidden();

  // UI：框标题和面板更新为新分支
  await expect(deck.frameEl('feat/other')).toHaveCount(1);
  await expect(deck.frameEl('main')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Branch feat\/other\. Switch branch/ })).toBeVisible();
  await deck.screenshot('switched');
  // 后台：git switch 了；workspace-service 更新记录并发 workspace.changed
  expect(git(sb, repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/other');
  await expect
    .poll(async () => (await wsChanged()).some((e) => e.workspace.id === workspaceId && e.workspace.branch === 'feat/other'))
    .toBe(true);
  const listed = await page.evaluate(() =>
    (window as unknown as { agentdeck: { workspaces: { list(): Promise<{ id: string; branch: string | null }[]> } } }).agentdeck.workspaces.list(),
  );
  expect(listed.find((w) => w.id === workspaceId)?.branch).toBe('feat/other');
  expect((await deck.board()).workspaces[workspaceId]?.branch).toBe('feat/other');

  // 有终端在跑（Running）时也一样先确认：claude 干着活，切回 main
  await deck.focusWindow(claude.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(claude.terminalId, 'running');
  await panel.getByRole('button', { name: /^Branch feat\/other\. Switch branch/ }).click();
  await page.getByRole('dialog', { name: 'Switch branch' }).getByRole('option', { name: /^main/ }).click();
  const back = page.getByRole('dialog', { name: 'Switch to main?' });
  await expect(back).toContainText('bash and claude are open in this folder.');
  expect(git(sb, repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/other');
  await back.getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(deck.frameEl('main')).toHaveCount(1);
  expect(git(sb, repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
});
