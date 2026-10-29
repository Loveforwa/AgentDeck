// TC-04（S2、S4）：agent 停下来请求批准，一眼看出是谁在等（前台：黄边框、Waiting · Needs approval、1 waiting；后台：系统通知、程序坞角标）。
// TC-13：关掉窗口（不是 ⌘Q），agent 在后台继续；要批准时弹系统通知、角标 1；单击通知窗口回来并跳到那个终端。
// 假 claude 的 PermissionRequest 钩子真的经 agentdeck-notify 到钩子 socket、状态机。
// 系统通知：主进程里把 Notification.prototype.show 换成只记下来（不真的弹到用户的通知中心），单击通知 = 对那个 Notification 发 click。
// 前台 / 后台：别的测试在同一台机器上跑，真的窗口焦点不可控；TC-04 在主进程里把 BrowserWindow.getFocusedWindow 固定成
// “AgentDeck 在前台” / “在后台”（应用判断前后台只看它）。TC-13 用真的：窗口隐藏了就不是前台。
// 窗口的关闭按钮是系统画的（hiddenInset 的红绿灯），Playwright 点不到：用 BrowserWindow.close()，走的是同一个 close 事件。
import type { ElectronApplication } from '@playwright/test';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, setupWorktree } from '../support/flows.ts';
import { patchSettings, sendLine } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

type Note = { title: string; body: string };

/** 主进程：记下系统通知；focus 为 'fg' / 'bg' 时固定前后台，null 时用真的。 */
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
    // 角标跟着前后台重算（应用里是窗口的 focus / blur 事件触发）
    for (const w of BrowserWindow.getAllWindows()) w.emit('blur');
  }, focus);
}

const notes = (app: ElectronApplication) =>
  app.evaluate(() => ((globalThis as unknown as { __notes?: Electron.Notification[] }).__notes ?? []).map((n) => ({ title: n.title, body: n.body }) as { title: string; body: string }));
const badge = (app: ElectronApplication) => app.evaluate(({ app }) => app.dock?.getBadge() ?? null);

async function setup(deck: Deck, branch: string) {
  patchSettings(deck.sb, { notifications: true });
  const repo = makeRepo(deck.sb, 'shop');
  await deck.launch();
  const ws = await setupWorktree(deck, repo, branch);
  const claude = await openFakeClaude(deck, ws.workspaceId);
  return { ...ws, claude };
}

test('TC-04 a claude asking for approval: yellow border, Waiting · Needs approval, 1 waiting within 2 s; in the background a notification and badge 1', async ({ deck, sb }) => {
  const { claude, workspaceId } = await setup(deck, 'feat/notify');
  const { page, app } = deck;
  const name = (await deck.board()).workspaces[workspaceId]!.name;
  await instrument(app, 'fg');
  // 焦点不在 claude 上（点白板空白处），黄边框才看得见
  const empty = await deck.emptyPoint();
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();

  // 1. 让 claude 执行一个要批准的命令（agent 自己停下来，不经过白板的键盘）；2. 不点任何东西，看 2 秒
  const t0 = Date.now();
  sendLine(sb, claude.terminalId, 'ask ls -la ~/other-shell');
  const win = deck.windowEl(claude.windowId);
  await expect(win.locator('.ad-window')).toHaveClass(/ad-window--attention/, { timeout: 2000 });
  await expect(win.locator('.ad-window-titlebar .ad-window-status--attention')).toHaveText(/^Waiting/, { timeout: 2000 });
  expect(Date.now() - t0).toBeLessThan(2000);
  await expect(win.locator('.ad-window-titlebar .ad-window-status--attention')).toHaveAttribute('title', 'Needs approval');
  await expect(deck.frameEl('feat/notify').locator('.ad-frame-waiting')).toHaveText('1 waiting');
  await expect(page.locator('.ad-topbar-waiting')).toHaveText(/1 waiting/);
  // 后台：钩子经 agentdeck-notify 到了，状态机广播了 needs-approval
  expect(deck.agentLog(claude.terminalId).some((e) => e.kind === 'hook' && e.event === 'PermissionRequest' && e.wired)).toBe(true);
  // 前台：不弹系统通知，角标为 0（S4 的规则：应用在前台时清掉）
  expect(await notes(app)).toEqual([]);
  expect(await badge(app)).toBe('');
  await deck.screenshot('foreground');

  // 3. 切到别的应用（AgentDeck 在后台），再触发一次
  sendLine(sb, claude.terminalId, '1');
  await deck.waitForStatus(claude.terminalId, 'running');
  await instrument(app, 'bg');
  sendLine(sb, claude.terminalId, 'done');
  await deck.waitForStatus(claude.terminalId, 'idle');
  sendLine(sb, claude.terminalId, 'ask pnpm install');
  await deck.waitForStatus(claude.terminalId, 'needs-approval');
  await expect.poll(() => notes(app)).toEqual([{ title: `claude · ${name} needs approval`, body: 'pnpm install' } satisfies Note]);
  await expect.poll(() => badge(app)).toBe('1');
  // 回到前台：角标清掉
  await instrument(app, 'fg');
  await expect.poll(() => badge(app)).toBe('');
});

test('TC-13 closing the window keeps the agent running; its approval request notifies, clicking the notification brings the window back to that terminal', async ({ deck, sb }) => {
  const { claude, workspaceId } = await setup(deck, 'feat/background');
  const { page, app } = deck;
  const name = (await deck.board()).workspaces[workspaceId]!.name;
  await instrument(app, null);
  sendLine(sb, claude.terminalId, 'work');
  await deck.waitForStatus(claude.terminalId, 'running');
  // 焦点放在别处（白板空白处）
  const empty = await deck.emptyPoint();
  await page.mouse.click(empty.x, empty.y);

  // 1. 关窗口（关闭按钮 = BrowserWindow 的 close）：窗口消失，应用还在，tmux 里的 claude 还在
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]);
  expect(app.process().exitCode).toBeNull();
  expect(sb.tmux(['has-session', '-t', `=${claude.terminalId}`]).status).toBe(0);

  // 2. 等 claude 请求批准：钩子照常到达，弹系统通知，角标 1
  sendLine(sb, claude.terminalId, 'done');
  sendLine(sb, claude.terminalId, 'ask pnpm test');
  await expect.poll(() => notes(app), { timeout: 20_000 }).toEqual([{ title: `claude · ${name} needs approval`, body: 'pnpm test' } satisfies Note]);
  await expect.poll(() => badge(app)).toBe('1');
  expect(deck.agentLog(claude.terminalId).filter((e) => e.kind === 'hook' && e.event === 'PermissionRequest').length).toBe(1);

  // 3. 单击系统通知：窗口回来，跳到那个终端（聚焦）
  await app.evaluate(() => (globalThis as unknown as { __notes: Electron.Notification[] }).__notes.at(-1)!.emit('click'));
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([true]);
  await expect.poll(async () => (await deck.board()).focusedId).toBe(claude.windowId);
  expect(await deck.status(claude.terminalId)).toBe('needs-approval');
  await deck.screenshot('back');
});
