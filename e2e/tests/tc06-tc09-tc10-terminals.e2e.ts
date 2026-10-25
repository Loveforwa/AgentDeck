// TC-06 在框里跑 dev server，点链接就在白板上看效果；TC-09 把终端拉小成摘要卡再恢复；TC-10 退出应用再打开，所有东西都还在。
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';
import { E2E_DIR } from '../support/sandbox.ts';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** tmux 里这个会话有没有 attach 着的客户端（白板的终端窗口显示它时就有一个）。 */
function attached(deck: Deck, terminalId: string): boolean {
  return deck.sb.tmux(['list-clients', '-F', '#{client_session}']).stdout.split('\n').includes(terminalId);
}

/** TC-06 的步骤 1–2：Shell 里跑 dev server，单击输出里的地址，等网页窗口出现并显示页面。 */
async function openPreview(deck: Deck) {
  const { sb, page } = deck;
  const repo = makeRepo(sb, 'web');
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/preview');
  const shell = await openTerminal(deck, workspaceId, 'shell');
  await deck.showAll();
  // 后台的识别结果：port-watch 从输出里找到地址时发 terminal.link
  await page.evaluate(() => {
    const w = window as unknown as { agentdeck: { on(t: string, l: (e: unknown) => void): void }; __e2eLinks: unknown[] };
    w.__e2eLinks = [];
    w.agentdeck.on('terminal.link', (e) => w.__e2eLinks.push(e));
  });

  // 1. 在终端里运行 dev server（真的键盘输入）
  const port = await freePort();
  const log = join(sb.root, 'requests.log');
  const requests = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  await deck.focusWindow(shell.windowId);
  await deck.typeLine(`node ${join(E2E_DIR, 'fake-agent/dev-server.mjs')} ${port} ${log}`);
  const url = `http://localhost:${port}/`;
  await deck.waitForPane(shell.terminalId, new RegExp(`Local: +${url.replace(/[/.]/g, '\\$&')}`));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __e2eLinks: { link: { kind: string; url: string } }[] }).__e2eLinks.map((e) => e.link.url)))
    .toContain(url);

  // 2. 单击输出里的 localhost 地址
  await deck.clickTerminalText(shell.windowId, shell.terminalId, url);
  const browserId = await deck.waitForWindow((w) => w.type === 'browser');
  const frame = deck.windowEl(browserId).frameLocator('iframe.ad-browser__frame');
  await expect(frame.locator('#hello')).toHaveText('Hello from the e2e dev server');
  await expect.poll(requests).toBeGreaterThan(0);
  return { workspaceId, shell, url, browserId, frame, requests };
}

test('TC-06 click a localhost link in a Shell: browser window opens beside it, a second click reuses it', async ({ deck }) => {
  await deck.launch();
  const { workspaceId, shell, url, browserId, frame } = await openPreview(deck);
  const b = await deck.board();
  const term = b.windows.find((w) => w.id === shell.windowId)!;
  const browser = b.windows.find((w) => w.id === browserId)!;
  // UI：网页窗口出现在终端右边、同一个框里，页面正常显示
  expect(browser.workspaceId).toBe(workspaceId);
  expect(browser.rect.x).toBeGreaterThanOrEqual(term.rect.x + term.rect.w);
  expect(browser.data['url']).toBe(url);
  await expect(frame.locator('#hello')).toBeVisible();
  // 后台：页面带着 X-Frame-Options: DENY 和 frame-ancestors 'none'，能嵌进来说明主进程改写了这个来源的响应头
  await deck.screenshot('browser-opened');

  // 3. 再单击一次同一个地址：聚焦已开的窗口（闪一下），不新开
  await deck.focusWindow(shell.windowId);
  await deck.clickTerminalText(shell.windowId, shell.terminalId, url);
  await expect.poll(async () => (await deck.board()).focusedId).toBe(browserId);
  await expect(deck.windowEl(browserId).locator('.ad-window-flash')).toHaveCount(1);
  expect((await deck.board()).windows.filter((w) => w.type === 'browser')).toHaveLength(1);
  await expect(frame.locator('#hello')).toBeVisible();
  await deck.screenshot('browser-reused');
});

// 已知缺口（待登记成 IS）：需求写“第二次单击聚焦并刷新已开的窗口”，现在只聚焦、闪一下，不刷新——
// 终端窗口打开网页时没带 reloadToken（packages/ui/widgets/terminal/src/TerminalWindow.tsx 的 onLink），网页窗口不知道要刷新。
// test.fail：现在这条“失败”才算通过；修好之后它会报“意外通过”，那时去掉 test.fail。
test('TC-06 a second click on the same link also refreshes the page (known gap)', async ({ deck }) => {
  test.fail(true, 'terminal link opens reuse the browser window without a reloadToken, so it is not refreshed');
  await deck.launch();
  const { shell, url, requests } = await openPreview(deck);
  const before = requests();
  await deck.focusWindow(shell.windowId);
  await deck.clickTerminalText(shell.windowId, shell.terminalId, url);
  await expect.poll(requests, { timeout: 8_000 }).toBeGreaterThan(before);
});

test('TC-09 shrink two terminals into summary cards, click one to restore it', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'api');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/cards');
  // 前提：框里有两个在跑的终端（一个在干活，一个在等批准，看等你的摘要卡是不是黄色）
  const a = await openFakeClaude(deck, workspaceId);
  const b = await openFakeClaude(deck, workspaceId);
  await deck.showAll();
  await deck.focusWindow(a.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(a.terminalId, 'running');
  await deck.focusWindow(b.windowId);
  await deck.typeLine('ask npm test');
  await deck.waitForStatus(b.terminalId, 'needs-approval');
  const before = await deck.board();
  const rectA = before.windows.find((w) => w.id === a.windowId)!.rect;

  // 1. 把两个终端的右下角往里拉到很小（真的拖动改大小的角）
  for (const t of [a, b]) {
    const handle = deck.windowEl(t.windowId).locator('.ad-window-resize--se');
    const box = (await handle.boundingBox())!;
    const zoom = (await deck.board()).viewport.zoom;
    const rect = (await deck.board()).windows.find((w) => w.id === t.windowId)!.rect;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - (rect.w - 240) * zoom, y - (rect.h - 130) * zoom, { steps: 15 });
    await page.mouse.up();
    await expect(deck.windowEl(t.windowId)).toHaveAttribute('data-summary', 'true');
  }

  // UI：小于 320×200 时变成摘要卡，显示最后几行和状态；在等你的仍是黄色
  const shrunk = await deck.board();
  for (const t of [a, b]) {
    const r = shrunk.windows.find((w) => w.id === t.windowId)!.rect;
    expect(r.w < 320 || r.h < 200).toBe(true);
  }
  await expect(deck.windowEl(a.windowId).locator('.ad-terminal__summary-line').last()).toContainText('Working');
  await expect(deck.windowEl(b.windowId).locator('.ad-terminal__summary')).toHaveAttribute('data-waiting', 'true');
  await expect(deck.windowEl(b.windowId).locator('.ad-window-status--attention')).toHaveText(/^Waiting/);
  await expect(deck.windowEl(b.windowId).locator('.ad-terminal__summary')).toContainText('No');
  await deck.screenshot('summary-cards');
  // 后台：摘要卡不 attach（tmux 里没有客户端），内容来自 capture-pane
  await expect.poll(() => attached(deck, a.terminalId)).toBe(false);
  await expect.poll(() => attached(deck, b.terminalId)).toBe(false);

  // 2. 单击其中一个摘要卡：恢复到拉小之前的大小并聚焦，重新 attach
  await deck.windowEl(a.windowId).locator('.ad-window-content').click({ delay: 80 });
  await expect(deck.windowEl(a.windowId)).not.toHaveAttribute('data-summary', 'true');
  await expect.poll(async () => (await deck.board()).windows.find((w) => w.id === a.windowId)!.rect).toEqual(rectA);
  await expect.poll(async () => (await deck.board()).focusedId).toBe(a.windowId);
  await expect.poll(() => attached(deck, a.terminalId)).toBe(true);
  await expect(deck.windowEl(a.windowId).locator('.ad-terminal__notice')).toHaveCount(0);
  // 画面不乱：恢复后还能照常输入
  await deck.typeLine('done');
  await deck.waitForStatus(a.terminalId, 'idle');
  await deck.screenshot('restored');
});

test('TC-10 quit with ⌘Q and reopen: frames, windows and terminals come back', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'api');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/restart');
  // 前提：白板上有框和两个终端，其中一个在跑
  const shell = await openTerminal(deck, workspaceId, 'shell');
  const agent = await openFakeClaude(deck, workspaceId);
  await deck.showAll();
  await deck.focusWindow(shell.windowId);
  await deck.typeLine('echo history-marker-$((6*7))');
  await deck.waitForPane(shell.terminalId, /history-marker-42/);
  await deck.focusWindow(agent.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(agent.terminalId, 'running');
  const before = await deck.board();
  await deck.screenshot('before-quit');
  void page;

  // 1. ⌘Q 退出
  await deck.quit();
  // 后台：tmux 里的会话在应用退出期间一直在跑
  expect(sb.tmux(['has-session', '-t', `=${shell.terminalId}`]).status).toBe(0);
  expect(sb.tmux(['has-session', '-t', `=${agent.terminalId}`]).status).toBe(0);
  expect(deck.agentLog(agent.terminalId).some((e) => e.kind === 'exit')).toBe(false);
  expect(attached(deck, shell.terminalId) || attached(deck, agent.terminalId)).toBe(false);

  // 2. 再打开（同一个数据目录、同一个 tmux）
  await deck.launch();
  // UI：框和窗口的位置、大小不变
  const after = await deck.board();
  expect(after.frames.map((f) => ({ ws: f.workspaceId, rect: f.rect }))).toEqual(before.frames.map((f) => ({ ws: f.workspaceId, rect: f.rect })));
  expect(after.windows.map((w) => ({ id: w.id, rect: w.rect, terminalId: w.data['terminalId'] }))).toEqual(
    before.windows.map((w) => ({ id: w.id, rect: w.rect, terminalId: w.data['terminalId'] })),
  );
  // UI：终端接回（没有 “Previous session ended” 之类的提示），历史输出都在
  for (const t of [shell, agent]) {
    await expect.poll(() => attached(deck, t.terminalId), { message: `${t.terminalId} re-attached` }).toBe(true);
    await expect(deck.windowEl(t.windowId).locator('.ad-terminal__notice')).toHaveCount(0);
  }
  expect(deck.pane(shell.terminalId)).toContain('history-marker-42');
  expect(deck.pane(agent.terminalId)).toContain('Working');
  // 后台：状态机重新登记了这些终端；输入照常送进去（接回的 claude 还活着）
  await expect.poll(() => deck.status(agent.terminalId)).not.toBeNull();
  await deck.focusWindow(agent.windowId);
  await deck.typeLine('done');
  await deck.waitForPane(agent.terminalId, /Done\./);
  await deck.waitForStatus(agent.terminalId, 'idle');
  await deck.screenshot('after-reopen');
});
