// TC-01 第一次打开应用，添加一个项目；TC-02 基于 main 新建一个分支工作区，开箱即用。
// 步骤和预期见 docs/status/tracking.py 的 CASES。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../support/fixtures.ts';
import { addProjectViaUi, createWorktreeInDialog } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';
import { git } from '../support/sandbox.ts';

test('TC-01 add a project from a subfolder, straight into New workspace', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  // 干净的数据目录：白板是空的
  expect((await deck.board()).projects).toHaveLength(0);

  // 后台：选子文件夹时探测结果是仓库根目录，并标明改用了根目录（usedRepoRoot）
  const probe = await page.evaluate(
    (f) => (window as unknown as { agentdeck: { projects: { probe(f: string): Promise<unknown> } } }).agentdeck.projects.probe(f),
    join(repo, 'src'),
  );
  expect(probe).toEqual(expect.objectContaining({ kind: 'git', repoRoot: repo, usedRepoRoot: true }));

  // 1–2. 空白处右键 › Add project…，选仓库的子文件夹 src/
  const dialog = await addProjectViaUi(deck, join(repo, 'src'));

  // UI：直接进入 New workspace，项目已选好
  await expect(dialog.getByRole('button', { name: 'Project' })).toHaveText(/shop/);
  await expect(dialog.getByRole('radio', { name: /New worktree/ })).toBeChecked();
  await deck.screenshot('new-workspace-dialog');

  // 后台：projects 表多一条，路径是仓库根目录，基础分支识别为 main
  const projects = await page.evaluate(() =>
    (window as unknown as { agentdeck: { projects: { list(): Promise<unknown[]> } } }).agentdeck.projects.list(),
  );
  expect(projects).toEqual([
    expect.objectContaining({ name: 'shop', kind: 'git', path: repo, repos: [expect.objectContaining({ path: repo, baseBranch: 'main' })] }),
  ]);
  // 再加一次同一个仓库（这次选根目录）：不重复添加
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await addProjectViaUi(deck, repo);
  expect((await deck.board()).projects).toHaveLength(1);
});

// 已知缺口（待登记成 IS）：TC-01 要求“选子文件夹时提示用了仓库根目录”。探测结果里有 usedRepoRoot，
// 但白板的 addProject（packages/ui/canvas/src/controller.ts）没有用它，界面上什么也不说。
// test.fail：现在失败才算通过；修好之后会报“意外通过”，那时去掉 test.fail。
test('TC-01 choosing a subfolder tells you the repo root was used (known gap)', async ({ deck, sb }) => {
  test.fail(true, 'addProject ignores ProjectProbe.usedRepoRoot, no hint is shown');
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  await addProjectViaUi(deck, join(repo, 'src'));
  await expect(page.getByText(/repo(sitory)? root|root folder/i)).toBeVisible({ timeout: 5_000 });
});

test('TC-02 new worktree workspace from main: frame, setup shell, .env copied', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop', { env: 'SECRET=from-main\n' });
  const page = await deck.launch();

  // 前提：已添加项目（TC-01），设置了初始化命令
  const dialog = await addProjectViaUi(deck, repo);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const projectId = (await deck.board()).projects[0]!.id;
  await page.evaluate(
    (id) =>
      (window as unknown as { agentdeck: { projects: { update(id: string, p: object): Promise<unknown> } } }).agentdeck.projects.update(id, {
        setupCommand: 'echo setup-ran > SETUP_OK.txt && echo setup finished',
      }),
    projectId,
  );

  // 1. 右键 › New workspace…（记下右键的位置，框应该出现在这里）
  const at = await deck.emptyPoint();
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const flowAt = await page.evaluate(
    (p) => (window as unknown as { __board: { clientToFlow(p: object): { x: number; y: number } } }).__board.clientToFlow(p),
    at,
  );
  await deck.pickMenu(['New workspace…']);
  const nw = page.getByRole('dialog', { name: 'New workspace' });
  await expect(nw).toBeVisible();
  const projectButton = nw.getByRole('button', { name: 'Project' });
  if (!/shop/.test((await projectButton.textContent()) ?? '')) {
    await projectButton.click();
    await page.getByRole('menuitem', { name: /shop/ }).click();
  }
  // 2. New worktree、New branch，名字 feat/oauth，from main
  await expect(nw.getByRole('button', { name: 'Base branch' })).toHaveText(/main/);
  await deck.screenshot('dialog-filled');
  // 3. Create
  const wsId = await createWorktreeInDialog(deck, 'feat/oauth');

  // UI：框出现在右键的位置，标题 “shop · feat/oauth”
  const b = await deck.board();
  const frame = b.frames.find((f) => f.workspaceId === wsId)!;
  expect(Math.abs(frame.rect.x - flowAt.x)).toBeLessThan(40);
  expect(Math.abs(frame.rect.y - flowAt.y)).toBeLessThan(40);
  const frameEl = deck.frameEl('feat/oauth');
  await expect(frameEl.locator('.ad-frame-project')).toHaveText('shop');

  // UI：框里自动开一个 Shell（名字 setup）运行初始化命令
  const setupId = await deck.waitForWindow((w) => w.workspaceId === wsId && w.type === 'terminal' && w.title === 'setup');
  const ws = (await deck.board()).workspaces[wsId]!;
  await expect.poll(() => existsSync(join(ws.path, 'SETUP_OK.txt')), { timeout: 30_000 }).toBe(true);
  await expect(deck.windowEl(setupId).locator('.ad-window-label')).toHaveText('setup');

  // UI：右侧面板显示 feat/oauth（单击框里的终端，面板跟着它）
  await deck.focusWindow(setupId);
  await expect(page.getByRole('button', { name: /^Branch feat\/oauth\. Switch branch/ })).toBeVisible();
  await deck.screenshot('workspace-created');

  // 后台：git worktree add 建好目录并新建分支；.env 被复制过去
  const worktrees = git(sb, repo, ['worktree', 'list', '--porcelain']);
  expect(worktrees).toContain(`worktree ${ws.path}`);
  expect(worktrees).toContain('branch refs/heads/feat/oauth');
  expect(git(sb, ws.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/oauth');
  expect(git(sb, ws.path, ['rev-parse', 'HEAD'])).toBe(git(sb, repo, ['rev-parse', 'main']));
  expect(readFileSync(join(ws.path, '.env'), 'utf8')).toBe('SECRET=from-main\n');
  // worktree 放在沙盒的数据目录里，不在用户的 ~/.agentdeck
  expect(ws.path.startsWith(sb.root)).toBe(true);
});
