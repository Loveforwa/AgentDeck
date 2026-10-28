// TC-03 同一个仓库开两个工作区，两个 claude 并行改代码互不影响；TC-08 想切到已被别的工作区占用的分支时，直接跳过去。
// agent 是假 claude（e2e/fake-agent/fake-claude.mjs），`edit <文件> [内容]` 像 agent 改了一个文件。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { createWorktreeInDialog, openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';
import { git } from '../support/sandbox.ts';

/** 右键一个框的空白处（框身中间）› New terminal › Claude Code，不等它起来。 */
async function newClaudeInFrame(deck: Deck, branch: string): Promise<void> {
  const box = await deck.frameEl(branch).boundingBox();
  if (!box) throw new Error(`frame ${branch} is not visible`);
  await deck.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await deck.pickMenu(['New terminal', 'Claude Code']);
}

test('TC-03 two worktrees of one repo, two claudes edit different files in parallel', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  // 前提：已有项目，已建好 feat/oauth 工作区（TC-02）
  const oauth = await setupWorktree(deck, repo, 'feat/oauth');

  // 1. 再建一个 fix/rate-limit 工作区（右键空白处 › New workspace…）
  await deck.showAll();
  const at = await deck.emptyPoint('right');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await deck.pickMenu(['New workspace…']);
  const nw = page.getByRole('dialog', { name: 'New workspace' });
  await expect(nw).toBeVisible();
  const projectButton = nw.getByRole('button', { name: 'Project' });
  if (!/shop/.test((await projectButton.textContent()) ?? '')) {
    await projectButton.click();
    await page.getByRole('menuitem', { name: /shop/ }).click();
  }
  const rateId = await createWorktreeInDialog(deck, 'fix/rate-limit');
  const rate = (await deck.board()).workspaces[rateId]!;
  await deck.showAll();

  // 2. 两个框里各新开一个 claude，紧接着连续开（中间不等）
  await newClaudeInFrame(deck, 'feat/oauth');
  await newClaudeInFrame(deck, 'fix/rate-limit');
  const isClaude = (ws: string) => (w: { type: string; workspaceId: string | null; data: Record<string, unknown> }) =>
    w.type === 'terminal' && w.workspaceId === ws && w.data['agent'] === 'claude' && typeof w.data['terminalId'] === 'string';
  const aWin = await deck.waitForWindow(isClaude(oauth.workspaceId));
  const bWin = await deck.waitForWindow(isClaude(rateId));
  const a = { windowId: aWin, terminalId: await deck.terminalIdOf(aWin) };
  const b = { windowId: bWin, terminalId: await deck.terminalIdOf(bWin) };
  expect(a.terminalId).not.toBe(b.terminalId);

  // UI：两个 claude 都正常启动（SessionStart 到了、Idle），窗口上没有 Connecting… / Previous session ended（IS-07）
  for (const t of [a, b]) {
    await deck.waitForPane(t.terminalId, /Fake Claude/);
    await deck.waitForStatus(t.terminalId, 'idle');
    await expect(deck.windowEl(t.windowId).locator('.ad-terminal__notice')).toHaveCount(0);
  }
  // UI：两个框各自显示自己的分支
  await expect(deck.frameEl('feat/oauth')).toHaveCount(1);
  await expect(deck.frameEl('fix/rate-limit')).toHaveCount(1);
  await deck.showAll();
  await deck.screenshot('two-claudes-started');

  // 3. 各让它改一个不同的文件（真键盘打进各自的终端）
  await deck.focusWindow(a.windowId);
  await deck.typeLine('edit oauth.txt token-refresh');
  await deck.focusWindow(b.windowId);
  await deck.typeLine('edit src/rate-limit.txt 100-per-minute');
  const edited = (t: { terminalId: string }) =>
    deck.agentLog(t.terminalId).find((e) => e.kind === 'edit') as { file?: string } | undefined;
  await expect.poll(() => edited(a)?.file ?? null, { timeout: 30_000 }).toBe(join(oauth.path, 'oauth.txt'));
  await expect.poll(() => edited(b)?.file ?? null, { timeout: 30_000 }).toBe(join(rate.path, 'src/rate-limit.txt'));
  await deck.waitForStatus(a.terminalId, 'idle');
  await deck.waitForStatus(b.terminalId, 'idle');
  expect(readFileSync(join(oauth.path, 'oauth.txt'), 'utf8')).toBe('token-refresh\n');
  expect(readFileSync(join(rate.path, 'src/rate-limit.txt'), 'utf8')).toBe('100-per-minute\n');

  // UI：右侧面板随聚焦切换，只显示各自 worktree 的改动
  const panel = page.getByRole('complementary', { name: 'Source Control' });
  const changes = panel.getByRole('region', { name: 'Changes', exact: true });
  const fileNames = changes.locator('.scm-row--file .scm-name');
  await deck.focusWindow(a.windowId);
  await expect(panel.getByRole('button', { name: /^Branch feat\/oauth\. Switch branch/ })).toBeVisible();
  await expect(fileNames).toHaveText(['oauth.txt']);
  await deck.screenshot('panel-oauth');
  await deck.focusWindow(b.windowId);
  await expect(panel.getByRole('button', { name: /^Branch fix\/rate-limit\. Switch branch/ })).toBeVisible();
  await expect(fileNames).toHaveText(['rate-limit.txt']);
  await deck.screenshot('panel-rate-limit');

  // 在 fix/rate-limit 的面板里暂存它的文件：只进这个 worktree 的暂存区
  const row = changes.locator('.scm-row--file', { has: page.locator('.scm-name', { hasText: /^rate-limit\.txt$/ }) });
  await row.hover();
  await row.getByRole('button', { name: 'Stage rate-limit.txt' }).click();
  await expect(panel.getByRole('region', { name: 'Staged Changes', exact: true }).locator('.scm-row--file')).toHaveCount(1);
  await deck.focusWindow(a.windowId);
  await expect(fileNames).toHaveText(['oauth.txt']);
  await expect(panel.getByRole('region', { name: 'Staged Changes', exact: true })).toHaveCount(0);

  // 后台：两个 worktree 各有自己的 HEAD 和暂存区
  expect(git(sb, oauth.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/oauth');
  expect(git(sb, rate.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('fix/rate-limit');
  expect(git(sb, oauth.path, ['status', '--porcelain'])).toBe('?? oauth.txt');
  expect(git(sb, rate.path, ['status', '--porcelain'])).toBe('A  src/rate-limit.txt');
  expect(git(sb, oauth.path, ['diff', '--cached', '--name-only'])).toBe('');
  expect(git(sb, rate.path, ['diff', '--cached', '--name-only'])).toBe('src/rate-limit.txt');
  expect(git(sb, repo, ['status', '--porcelain'])).toBe('');
  // 后台：两个 tmux 会话的工作目录分别是两个 worktree；agent 的钩子也报的是各自的目录
  const cwdOf = (id: string) => sb.tmux(['display-message', '-p', '-t', `=${id}:`, '#{pane_current_path}']).stdout.trim();
  expect(cwdOf(a.terminalId)).toBe(oauth.path);
  expect(cwdOf(b.terminalId)).toBe(rate.path);
  const startCwd = (id: string) =>
    (deck.agentLog(id).find((e) => e.kind === 'hook' && e.event === 'SessionStart') as { payload?: { cwd?: string } } | undefined)?.payload?.cwd;
  expect(startCwd(a.terminalId)).toBe(oauth.path);
  expect(startCwd(b.terminalId)).toBe(rate.path);
});

test('TC-08 clicking a branch checked out in another workspace jumps to that frame, no git', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  // 前提：同一仓库有 feat/oauth 和 fix/rate-limit 两个工作区（TC-03）
  const oauth = await setupWorktree(deck, repo, 'feat/oauth');
  const rate = await setupWorktree(deck, repo, 'fix/rate-limit');
  const shell = await openTerminal(deck, oauth.workspaceId, 'shell');
  await openTerminal(deck, rate.workspaceId, 'shell');
  // 视口放大到 feat/oauth 那个框，fix/rate-limit 不在屏幕中间（之后看白板有没有平移过去）
  await page.evaluate((ws) => (window as unknown as { __board: { fitFrame(ws: string): void } }).__board.fitFrame(ws), oauth.workspaceId);
  await expect.poll(async () => (await deck.board()).viewport.zoom, { intervals: [300] }).toBeGreaterThan(0);

  const refs = () => ({
    refs: git(sb, repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
    oauthHead: git(sb, oauth.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    rateHead: git(sb, rate.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    oauthReflog: git(sb, oauth.path, ['reflog', '--format=%H %gs', 'HEAD']),
    rateReflog: git(sb, rate.path, ['reflog', '--format=%H %gs', 'HEAD']),
    worktrees: git(sb, repo, ['worktree', 'list', '--porcelain']),
  });
  const before = refs();

  // 1. 聚焦 feat/oauth 里的终端
  await deck.focusWindow(shell.windowId);
  const panel = page.getByRole('complementary', { name: 'Source Control' });
  // 2. 面板里单击分支按钮
  await panel.getByRole('button', { name: /^Branch feat\/oauth\. Switch branch/ }).click();
  const picker = page.getByRole('dialog', { name: 'Switch branch' });
  await expect(picker).toBeVisible();
  // UI：fix/rate-limit 灰显并写着 “in fix/rate-limit”
  const option = picker.getByRole('option', { name: /fix\/rate-limit/ });
  await expect(option).toHaveAttribute('data-occupied', 'true');
  await expect(option.locator('.scm-branch-option-note')).toHaveText('in fix/rate-limit');
  await expect(option).toHaveAttribute('title', 'Checked out in fix/rate-limit. Click to go there.');
  // 灰显：名字的颜色和没被占用的分支不一样
  const free = picker.getByRole('option', { name: /New branch/ });
  const colorOf = (l: typeof option) => l.locator('.scm-branch-name').evaluate((el) => getComputedStyle(el).color);
  expect(await colorOf(option)).not.toBe(await colorOf(free));
  const viewportBefore = (await deck.board()).viewport;
  await deck.screenshot('occupied-branch');

  // 3. 单击灰显的 fix/rate-limit
  await option.click();
  await expect(picker).toBeHidden();
  // UI：白板平移到那个框并选中它，面板跟着换到 fix/rate-limit
  await expect.poll(async () => (await deck.board()).selectedFrame).toBe(rate.workspaceId);
  await expect.poll(async () => JSON.stringify((await deck.board()).viewport), { timeout: 10_000 }).not.toBe(JSON.stringify(viewportBefore));
  await expect(panel.getByRole('button', { name: /^Branch fix\/rate-limit\. Switch branch/ })).toBeVisible();
  // 框整个在白板可见区域里
  await expect
    .poll(async () => {
      const pane = await page.locator('.react-flow__pane').boundingBox();
      const f = await deck.frameEl('fix/rate-limit').boundingBox();
      if (!pane || !f) return false;
      return f.x >= pane.x - 1 && f.y >= pane.y - 1 && f.x + f.width <= pane.x + pane.width + 1 && f.y + f.height <= pane.y + pane.height + 1;
    })
    .toBe(true);
  await deck.screenshot('jumped');

  // 后台：分支列表来自 git worktree list（被占用的路径就是 fix/rate-limit 的 worktree）；没有执行任何 git 操作
  const branches = await page.evaluate(
    (p) => (window as unknown as { agentdeck: { git: { branches(p: string): Promise<{ name: string; checkedOutAt: string | null }[]> } } }).agentdeck.git.branches(p),
    oauth.path,
  );
  expect(branches.find((x) => x.name === 'fix/rate-limit')?.checkedOutAt).toBe(rate.path);
  expect(git(sb, repo, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${rate.path}\nHEAD`);
  expect(refs()).toEqual(before);
});
