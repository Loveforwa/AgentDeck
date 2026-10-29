// IS-14：系统通知、单击后窗口回来并跳到终端。批准请求那条（状态机 → alerts → Notification）由 tc04-tc13-notify 覆盖；
// 这里补另一条通知来源：agent 做完事调 notify（MCP 的 notify 工具 / agentdeck notify，例如 “Tests passed”）——
// 主进程 onNotify 在应用在后台时 new Notification({ title: “claude · <工作区>”, body }) 并挂 click：showWindow + app.focus-terminal。
// 另外补 TC-13 没断言的：单击通知前视口已经移开（终端在屏幕外），单击后视口移回来、终端在画面里、键盘焦点在那个终端的 xterm 里。
//
// 不弹真通知：主进程里把 Notification.prototype.show 换成只记下来，单击 = 对那个 Notification 发 click（Electron 的 click 事件就是它）。
// 前后台：TC-04 那样在主进程固定 BrowserWindow.getFocusedWindow（别的测试同时在跑，真焦点不可控）；关窗口后用真的（隐藏的窗口不是前台）。
// 只能人工：macOS 通知中心里真的弹出来（要应用有通知权限）、真的用鼠标点那条通知。
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, setupWorktree } from '../support/flows.ts';
import { mcpCall, patchSettings, sendLine } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

async function instrument(app: ElectronApplication, focus: 'fg' | 'bg' | null) {
  await app.evaluate(({ BrowserWindow, Notification }, focus) => {
    const g = globalThis as unknown as { __notes?: Electron.Notification[]; __focus?: string | null; __realFocused?: () => Electron.BrowserWindow | null };
    g.__notes ??= [];
    g.__focus = focus;
    Notification.prototype.show = function show(this: Electron.Notification) {
      g.__notes!.push(this);
    };
    g.__realFocused ??= BrowserWindow.getFocusedWindow.bind(BrowserWindow);
    BrowserWindow.getFocusedWindow = () => (g.__focus === 'fg' ? (BrowserWindow.getAllWindows()[0] ?? null) : g.__focus === 'bg' ? null : g.__realFocused!());
  }, focus);
}
const notes = (app: ElectronApplication) =>
  app.evaluate(() => ((globalThis as unknown as { __notes?: Electron.Notification[] }).__notes ?? []).map((n) => ({ title: n.title, body: n.body })));
const clickLastNote = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __notes: Electron.Notification[] }).__notes.at(-1)!.emit('click'));
const visible = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));

test('IS-14 an agent’s “done” notify in the background pops a system notification; clicking it brings the window back, scrolls to and focuses that terminal', async ({ deck, sb }) => {
  patchSettings(sb, { notifications: true });
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/report');
  const claude = await openFakeClaude(deck, workspaceId);
  const name = (await deck.board()).workspaces[workspaceId]!.name;
  const { app } = deck;
  sendLine(sb, claude.terminalId, 'work');
  await deck.waitForStatus(claude.terminalId, 'running');

  // 前台：notify 只在白板上出提示，不发系统通知
  await instrument(app, 'fg');
  await page.waitForTimeout(2100); // 2 秒内按过键时 notify 只闪不弹提示（N1）
  expect((await mcpCall(sb, claude.terminalId, 'notify', { message: 'Halfway there' })).isError).toBe(false);
  await expect(page.getByText(/: Halfway there$/)).toBeVisible({ timeout: 15_000 });
  expect(await notes(app)).toEqual([]);

  // 视口移开：终端完全不在画面里（空白处滚轮平移，TC-37）
  const empty = await deck.emptyPoint('right');
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.wheel(1500, 0);
    const box = await deck.windowEl(claude.windowId).boundingBox();
    if (!box || box.x + box.width < 0) break;
  }
  await expect.poll(async () => {
    const box = await deck.windowEl(claude.windowId).boundingBox();
    return box === null || box.x + box.width < 0 || box.x > viewport.width;
  }).toBe(true);
  await deck.screenshot('scrolled-away');

  // 关窗口（关闭按钮 = BrowserWindow.close）：窗口隐藏，应用和 claude 还在；之后用真的前后台判断
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => visible(app)).toEqual([false]);
  await instrument(app, null);
  expect(sb.tmux(['has-session', '-t', `=${claude.terminalId}`]).status).toBe(0);

  // agent 做完了：Stop 钩子 + 调 notify（像 claude 跑完测试后说 “Tests passed”）
  sendLine(sb, claude.terminalId, 'done');
  await deck.waitForStatus(claude.terminalId, 'idle');
  expect((await mcpCall(sb, claude.terminalId, 'notify', { message: 'Tests passed' })).isError).toBe(false);
  await expect.poll(() => notes(app), { timeout: 20_000 }).toEqual([{ title: `claude · ${name}`, body: 'Tests passed' }]);
  // 做完回到 idle 本身不发通知（S4：只有新的等你请求才通知），所以只有这一条
  expect(await notes(app)).toHaveLength(1);

  // 单击通知：窗口回来，视口移到那个终端，选中它，键盘焦点在它的 xterm 里
  await clickLastNote(app);
  await expect.poll(() => visible(app)).toEqual([true]);
  await expect.poll(async () => (await deck.board()).focusedId).toBe(claude.windowId);
  await expect
    .poll(async () => {
      const box = await deck.windowEl(claude.windowId).boundingBox();
      return box !== null && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
    })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => (document.activeElement?.closest('.ad-window-node') as HTMLElement | null)?.dataset['windowId'] ?? null))
    .toBe(claude.windowId);
  await deck.screenshot('back-at-terminal');
  // 焦点真的在终端里：打的字进了 claude
  await page.keyboard.type('done after-notification');
  await page.keyboard.press('Enter');
  await expect.poll(() => deck.agentLog(claude.terminalId).some((e) => e.kind === 'input' && e.line === 'done after-notification')).toBe(true);
});

test('IS-14 with notifications turned off in Settings nothing is sent in the background', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/quiet');
  const claude = await openFakeClaude(deck, workspaceId);
  const { app } = deck;
  // 沙盒默认 notifications: false（真的设置文件），在后台
  await instrument(app, 'bg');
  sendLine(sb, claude.terminalId, 'ask pnpm test');
  await deck.waitForStatus(claude.terminalId, 'needs-approval');
  expect((await mcpCall(sb, claude.terminalId, 'notify', { message: 'Tests passed' })).isError).toBe(false);
  // 给主进程时间处理两条（状态广播、notify），再看
  await expect.poll(() => app.evaluate(({ app }) => app.dock?.getBadge() ?? '1')).toBe('1');
  expect(await notes(app)).toEqual([]);
});
