// TC-16 刚打开应用（没聚焦任何窗口）右侧源代码管理说怎么用，左边管理面板列着整块白板；聚焦后右侧显示那个工作区的 git 状态，只刷新一次；
// TC-33 左边管理面板（MP2，取代右侧的 BoardNav）列出整块白板：项目 → 工作路径 → 每个窗口一行，在等你的在 NEEDS YOU，单击跳过去。
// 2026-10-30 起右侧只放源代码管理（MP3），快速定位搬进了左边管理面板。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openManager, openTerminal, setupWorktree } from '../support/flows.ts';
import { clearInvokes, invokes, recordInvokes } from '../support/g1.ts';
import { makeRepo } from '../support/repo.ts';

async function clickEmpty(deck: Deck): Promise<{ x: number; y: number }> {
  const p = await deck.emptyPoint('bottom');
  await deck.page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();
  await expect.poll(async () => (await deck.board()).selectedFrame).toBeNull();
  return p;
}

test('TC-16 on launch the side panel says to focus a terminal and the manager lists the board; focusing a terminal shows its workspace git status, refreshed once', async ({ deck, sb }) => {
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
  // UI：右侧不是 “This window isn’t in a workspace.”（IS-22），而是告诉你怎么用
  await expect(panel).toContainText('Focus a terminal to see its changes.');
  await expect(panel).not.toContainText('isn’t in a workspace');
  // 左边管理面板：项目 → 工作路径 → 两个终端，单击就能跳过去
  const nav = await openManager(deck);
  await expect(nav.getByRole('group', { name: 'api · feat/panel' })).toBeVisible();
  await expect(nav.getByRole('group', { name: 'api · feat/panel' }).locator('.mgr-row--open')).toHaveCount(2);
  await deck.screenshot('launch-manager');

  // 2. 单击框里的一个终端
  await clearInvokes(deck);
  await deck.focusWindow(a.windowId);
  // UI：面板换成这个工作区的源代码管理：分支 feat/panel、没有改动
  const scm = deck.page.getByRole('complementary', { name: 'Source Control' });
  await expect(scm).toBeVisible();
  await expect(scm).toContainText('feat/panel');
  // 左边管理面板还在
  await expect(nav).toBeVisible();
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

test('TC-33 the manager lists the whole board, the waiting terminal under NEEDS YOU; clicking it jumps to it', async ({ deck, sb }) => {
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

  // 1. 单击白板空白处，打开左边管理面板
  await clickEmpty(deck);
  const nav = await openManager(deck);
  await expect(page.locator('aside.ad-panel')).toContainText('Focus a terminal to see its changes.');
  // 2. 看管理面板：项目 → 工作路径（分支）→ 窗口，在等你的在最上面的 NEEDS YOU
  const projects = nav.locator('.mgr-project-label');
  expect((await projects.allInnerTexts()).filter((n) => n === 'api' || n === 'shop').sort()).toEqual(['api', 'shop']);
  await expect(nav.getByRole('group', { name: 'api · feat/login' })).toBeVisible();
  await expect(nav.getByRole('group', { name: 'api · feat/pool' })).toBeVisible();
  await expect(nav.getByRole('group', { name: 'shop · feat/cart' })).toBeVisible();
  const sel = (id: string) => `.mgr-row[data-window-id="${id}"]`;
  const row = (id: string) => nav.locator(sel(id));
  // 每个窗口一行：状态灯、标题（Shell 没有会话，用对话主题）
  await expect(nav.getByRole('group', { name: 'api · feat/login' }).locator(sel(shell.windowId))).toBeVisible();
  await expect(row(shell.windowId).locator('.mgr-lamp')).toHaveCount(1);
  await expect(row(shell.windowId).locator('.mgr-agent[data-agent="shell"]')).toHaveCount(1);
  await expect(row(shell.windowId).locator('.mgr-row-title')).toHaveText('Check local git history');
  await expect(nav.getByRole('group', { name: 'shop · feat/cart' }).locator(sel(other.windowId))).toBeVisible();
  // 网页窗口没有灯，是一个小窗口图标
  await expect(row(browserId!).locator('[data-icon="window"]')).toHaveCount(1);
  await expect(row(browserId!).locator('.mgr-lamp')).toHaveCount(0);
  // 在等你的那行：在 NEEDS YOU（只此一行），浅黄底（--attention-soft）、右边 “Waiting · …”，下面的项目里不再出现
  const needs = nav.getByRole('region', { name: 'Needs you' });
  await expect(needs.getByRole('heading')).toHaveText('NEEDS YOU · 1');
  const waiting = needs.locator(sel(claude.windowId));
  await expect(waiting).toHaveClass(/mgr-row--waiting/);
  await expect(waiting.locator('.mgr-time')).toHaveText(/^Waiting · (now|\d+m)$/);
  await expect(waiting.locator('.mgr-where')).toHaveText('api · feat/pool');
  await expect(nav.locator(sel(claude.windowId))).toHaveCount(1);
  const soft = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--attention-soft)';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  });
  await expect.poll(() => waiting.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(soft);
  await deck.screenshot('manager');

  // 3. 单击列表里在等你的那个终端：白板平移过去、窗口闪一下并聚焦，面板回到这个工作区的源代码管理
  const before = (await deck.board()).viewport;
  await waiting.locator('.mgr-row-main').click();
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
  await expect(nav).toBeVisible();
  await deck.screenshot('jumped');
});
