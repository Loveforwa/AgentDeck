// TC-16 刚打开应用（没聚焦任何窗口）右侧面板给出有用的信息，聚焦后显示那个工作区的 git 状态，只刷新一次；
// TC-33 没选中任何窗口时右侧面板是整块白板的目录（BoardNav 的 Board 视图），单击在等你的那行跳过去。
// 2026-10-28 起没聚焦时的面板是 BoardNav（Board / Agents 两个视图，见 docs/components.md），不再是 “Select a window…” 一句话。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { clearInvokes, invokes, recordInvokes } from '../support/g1.ts';
import { makeRepo } from '../support/repo.ts';

async function clickEmpty(deck: Deck): Promise<{ x: number; y: number }> {
  const p = await deck.emptyPoint('bottom');
  await deck.page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();
  await expect.poll(async () => (await deck.board()).selectedFrame).toBeNull();
  return p;
}

test('TC-16 on launch the side panel shows the board; focusing a terminal shows its workspace git status, refreshed once', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'api');
  await deck.launch();
  // 前提：白板上有一个工作区框，里面两个终端
  const { workspaceId, path } = await setupWorktree(deck, repo, 'feat/panel');
  const a = await openTerminal(deck, workspaceId, 'shell');
  const b = await openTerminal(deck, workspaceId, 'shell');
  await deck.showAll();
  await deck.quit();

  // 1. 打开应用，不点任何东西
  await deck.launch();
  await recordInvokes(deck);
  expect((await deck.board()).focusedId).toBeNull();
  const panel = deck.page.locator('aside.ad-panel');
  const nav = deck.page.getByRole('navigation', { name: 'Board' });
  // UI：不是 “This window isn’t in a workspace.”（IS-22），而是整块白板的目录：项目 → 工作区 → 两个终端，单击就能跳过去
  await expect(nav.getByRole('heading', { name: 'BOARD' })).toBeVisible();
  await expect(panel).not.toContainText('isn’t in a workspace');
  await expect(nav.getByRole('group', { name: 'api · feat/panel' })).toBeVisible();
  await expect(nav.locator('.bnav-row')).toHaveCount(2);
  await deck.screenshot('launch-board-nav');

  // 2. 单击框里的一个终端
  await clearInvokes(deck);
  await deck.focusWindow(a.windowId);
  // UI：面板换成这个工作区的源代码管理：分支 feat/panel、没有改动
  const scm = deck.page.getByRole('complementary', { name: 'Source Control' });
  await expect(scm).toBeVisible();
  await expect(scm).toContainText('feat/panel');
  await expect(nav).toHaveCount(0);
  await deck.screenshot('focused-scm');
  // 后台：聚焦变化时 git.status 只调一次（这个工作区的路径）
  const statusCalls = async () => (await invokes(deck)).filter((c) => c.call === 'git.status' && c.arg === path).length;
  await expect.poll(statusCalls).toBe(1);
  await deck.page.waitForTimeout(1500);
  expect(await statusCalls()).toBe(1);
  // 再聚焦同一个工作区里的另一个终端：工作区没变，不再刷新
  await deck.focusWindow(b.windowId);
  await deck.page.waitForTimeout(1500);
  expect(await statusCalls()).toBe(1);
  expect((await invokes(deck)).filter((c) => c.call === 'git.status').length).toBe(1);
});

test('TC-33 with nothing selected the side panel lists the whole board; clicking the waiting terminal jumps to it', async ({ deck, sb }) => {
  const api = makeRepo(sb, 'api');
  const shop = makeRepo(sb, 'shop');
  const page = await deck.launch();
  // 前提：两个项目、三个工作区、几个终端和一个网页窗口；其中一个终端在等你
  const ws1 = await setupWorktree(deck, api, 'feat/login');
  const ws2 = await setupWorktree(deck, api, 'feat/pool');
  const ws3 = await setupWorktree(deck, shop, 'feat/cart');
  const shell = await openTerminal(deck, ws1.workspaceId, 'shell');
  const claude = await openFakeClaude(deck, ws2.workspaceId);
  const other = await openTerminal(deck, ws3.workspaceId, 'shell');
  const browserId = await page.evaluate(
    (ws) => (window as unknown as { __board: { newBrowser(o: object): string | null } }).__board.newBrowser({ workspaceId: ws }),
    ws3.workspaceId,
  );
  expect(browserId).not.toBeNull();
  await deck.showAll();
  // 对话主题：程序自己设的终端标题（OSC 2），TerminalInfo.title
  // （准备场景，不是被测步骤：按键直接经 tmux 送进去；白板缩得小时终端是摘要卡，键盘进不去）
  await deck.waitForPane(shell.terminalId, /e2e\$/);
  sb.tmux(['send-keys', '-t', `=${shell.terminalId}:`, '-l', `printf '\\033]2;Check local git history\\007'`]);
  sb.tmux(['send-keys', '-t', `=${shell.terminalId}:`, 'Enter']);
  await expect
    .poll(async () =>
      page.evaluate(
        async (id) =>
          (
            await (window as unknown as { agentdeck: { terminals: { list(): Promise<{ id: string; title: string | null }[]> } } }).agentdeck.terminals.list()
          ).find((t) => t.id === id)?.title ?? null,
        shell.terminalId,
      ),
    )
    .toBe('Check local git history');
  sb.tmux(['send-keys', '-t', `=${claude.terminalId}:`, '-l', 'ask npm test']);
  sb.tmux(['send-keys', '-t', `=${claude.terminalId}:`, 'Enter']);
  await deck.waitForStatus(claude.terminalId, 'needs-approval');
  await page.evaluate(() => (window as unknown as { __board: { zoomTo(z: number): void } }).__board.zoomTo(0.4));
  // 缩到 40%：终端都成了摘要卡，单击列表里的行要把白板移过去、放大到看得清
  await expect.poll(async () => (await deck.board()).viewport.zoom).toBeCloseTo(0.4, 2);

  // 1. 单击白板空白处
  await clickEmpty(deck);
  // 2. 看右侧面板：BOARD → 项目 → 工作区（分支）→ 窗口
  const nav = page.getByRole('navigation', { name: 'Board' });
  await expect(nav.getByRole('heading', { name: 'BOARD' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Board', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // 项目、工作区按白板上的位置排，这里只核对有哪些
  await expect(nav.locator('.bnav-project-name')).toHaveCount(2);
  expect((await nav.locator('.bnav-project-name').allInnerTexts()).sort()).toEqual(['api', 'shop']);
  expect((await nav.getByRole('region', { name: 'api' }).locator('.bnav-workspace-name').allInnerTexts()).sort()).toEqual(['feat/login', 'feat/pool']);
  await expect(nav.getByRole('region', { name: 'shop' }).locator('.bnav-workspace-name')).toHaveText(['feat/cart']);
  const sel = (id: string) => `.bnav-row[data-window-id="${id}"]`;
  const row = (id: string) => nav.locator(sel(id));
  // 每个窗口一行：状态灯、名字、对话主题
  await expect(nav.getByRole('group', { name: 'api · feat/login' }).locator(sel(shell.windowId))).toBeVisible();
  await expect(row(shell.windowId).locator('.bnav-lamp')).toHaveCount(1);
  await expect(row(shell.windowId).locator('.bnav-name')).toHaveText('bash');
  await expect(row(shell.windowId).locator('.bnav-topic')).toHaveText('· Check local git history');
  await expect(nav.getByRole('group', { name: 'shop · feat/cart' }).locator(sel(other.windowId))).toBeVisible();
  // 网页窗口没有灯，是一个小窗口图标
  await expect(row(browserId!).locator('[data-icon="window"]')).toHaveCount(1);
  await expect(row(browserId!).locator('.bnav-lamp')).toHaveCount(0);
  // 在等你的那行：浅黄底（--attention-soft）、“· Waiting”，其他行没有
  const waiting = row(claude.windowId);
  await expect(nav.getByRole('group', { name: 'api · feat/pool' }).locator(sel(claude.windowId))).toBeVisible();
  await expect(waiting).toHaveClass(/bnav-row--waiting/);
  await expect(waiting.locator('.bnav-waiting')).toHaveText('· Waiting');
  await expect(nav.locator('.bnav-row--waiting')).toHaveCount(1);
  const soft = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--attention-soft)';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  });
  await expect.poll(() => waiting.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(soft);
  await deck.screenshot('board-nav');

  // 3. 单击列表里在等你的那个终端：白板平移过去、窗口闪一下并聚焦，面板回到这个工作区的源代码管理
  const before = (await deck.board()).viewport;
  await waiting.click();
  await expect.poll(async () => (await deck.board()).focusedId).toBe(claude.windowId);
  await expect(deck.windowEl(claude.windowId).locator('.ad-window-flash')).toHaveCount(1);
  await expect.poll(async () => JSON.stringify((await deck.board()).viewport)).not.toBe(JSON.stringify(before));
  await expect.poll(async () => (await deck.board()).viewport.zoom).toBeGreaterThanOrEqual(0.5);
  await expect(deck.windowEl(claude.windowId)).not.toHaveAttribute('data-summary', 'true');
  // 窗口整个在白板的可见区域里
  await expect
    .poll(async () => {
      const pane = await page.locator('.react-flow__pane').boundingBox();
      const win = await deck.windowEl(claude.windowId).boundingBox();
      return !!pane && !!win && win.x >= pane.x && win.y >= pane.y && win.x + win.width <= pane.x + pane.width && win.y + win.height <= pane.y + pane.height;
    })
    .toBe(true);
  const scm = page.getByRole('complementary', { name: 'Source Control' });
  await expect(scm).toBeVisible();
  await expect(scm).toContainText('feat/pool');
  await expect(nav).toHaveCount(0);
  await deck.screenshot('jumped');
});
