// TC-18 焦点在网页窗口里时，应用快捷键照样能用：⌘J ⌘B ⌘W ⌘0 ⌘1 照常生效，⌘R 只刷新这个网页、不重载整个应用。
// 分两段核对：
// - 按键真的进了网页：焦点在网页（跨源 iframe）里时，用连到这个 frame 的 CDP 会话按 ⌘B（像真键盘一样网页先收到），
//   白板页面一个 keydown 也收不到、面板不动——所以只能靠应用菜单；⌘R 也这样按，网页里的小桥收到、只刷新网页。
// - 菜单这一段：这几个快捷键是应用菜单的 accelerator，触发菜单项（和系统把没人处理的 ⌘ 组合键交给菜单一样）后，
//   焦点仍在网页里，白板照常执行（renderer 的 menu-shortcuts 认 iframe 在窗口内容里）。
// 真键盘 → 系统 → 菜单这一步测试里按不出来（CDP 的按键浏览器端不处理；webContents.sendInputEvent 直接进顶层页面、
// 不经过 iframe，试过会误判成通过），要人用真键盘试一次。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal } from '../support/flows.ts';
import { clickMenuAccelerator, pressInFrame, recordSends, sends } from '../support/g1.ts';
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

let server: ChildProcess | null = null;
test.afterEach(() => {
  server?.kill();
  server = null;
});

test('TC-18 with focus inside a web page, ⌘J ⌘B ⌘W ⌘0 ⌘1 still work and ⌘R reloads only that page', async ({ deck, sb }) => {
  const page = await deck.launch();
  // 前提：白板上有一个网页窗口和一个终端（终端在等你，⌘J 才有地方跳）
  const port = await freePort();
  const log = join(sb.root, 'requests.log');
  const requests = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  server = spawn(process.execPath, [join(E2E_DIR, 'fake-agent/dev-server.mjs'), String(port), log], { stdio: 'ignore' });
  const url = `http://localhost:${port}/`;
  await expect.poll(async () => fetch(url).then((r) => r.ok, () => false)).toBe(true);
  const claude = await openTerminal(deck, null, 'claude', undefined, { x: 40, y: 40 });
  await deck.waitForStatus(claude.terminalId, 'idle');
  sb.tmux(['send-keys', '-t', `=${claude.terminalId}:`, '-l', 'ask npm test']);
  sb.tmux(['send-keys', '-t', `=${claude.terminalId}:`, 'Enter']);
  await deck.waitForStatus(claude.terminalId, 'needs-approval');
  const browserId = await page.evaluate(
    (url) =>
      (window as unknown as { __board: { openWindow(from: null, req: object): string | null } }).__board.openWindow(null, {
        type: 'browser',
        data: { url },
        workspaceId: null,
        rect: { x: 620, y: 40, w: 460, h: 360 },
      }),
    url,
  );
  expect(browserId).not.toBeNull();
  const frame = deck.windowEl(browserId!).frameLocator('iframe.ad-browser__frame');
  await expect(frame.locator('#hello')).toBeVisible();
  await recordSends(deck);
  // 整个应用没有重载过：页面上的这个标记一直在
  await page.evaluate(() => ((window as unknown as { __g1Marker: number }).__g1Marker = 42));
  const marker = () => page.evaluate(() => (window as unknown as { __g1Marker?: number }).__g1Marker ?? null);

  /** 1. 单击网页内容：白板聚焦这个网页窗口，焦点进了网页（iframe）。 */
  const clickPage = async () => {
    // 窗口没聚焦时第一下单击只聚焦（内容上盖着一层，canvas 的规则），再单击才进网页
    const inside = () => page.evaluate(() => document.activeElement?.tagName === 'IFRAME');
    await frame.locator('#hello').click({ delay: 80, position: { x: 20, y: 10 } });
    if (!(await inside())) await frame.locator('#hello').click({ delay: 80, position: { x: 20, y: 10 } });
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
    await expect.poll(async () => (await deck.board()).focusedId).toBe(browserId);
  };
  const panelOpen = () => page.evaluate(() => (window as unknown as { __board: { state: { panel: { open: boolean } } } }).__board.state.panel.open);
  const viewport = async (d: Deck) => (await d.board()).viewport;
  /** 视口放回原点、100%（准备下一步，不是被测的步骤）。 */
  const setView = async (v: { x: number; y: number; zoom: number }) => {
    await page.evaluate((v) => (window as unknown as { __board: { setViewport(v: object, d?: number): void } }).__board.setViewport(v, 0), v);
    await expect.poll(async () => JSON.stringify(await viewport(deck))).toBe(JSON.stringify(v));
    // 等 React Flow 真的画到这个位置（视口动画停下）
    await expect
      .poll(() => page.evaluate(() => document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? ''))
      .toContain(`translate(${v.x}px, ${v.y}px) scale(${v.zoom})`);
  };
  await setView({ x: 0, y: 0, zoom: 1 });

  // 白板页面收到的 keydown（焦点在网页里时应该一个都没有）
  await page.evaluate(() => {
    const w = window as unknown as { __g1Keys: string[] };
    w.__g1Keys = [];
    window.addEventListener('keydown', (e) => w.__g1Keys.push(`${e.metaKey ? 'Meta+' : ''}${e.key}`), true);
  });
  const topKeys = () => page.evaluate(() => (window as unknown as { __g1Keys: string[] }).__g1Keys);

  const webFrame = page.frames().find((f) => f.url().startsWith(url));
  if (!webFrame) throw new Error('web page frame not found');
  await webFrame.evaluate(() => {
    const w = window as unknown as { __g1Keys: string[] };
    w.__g1Keys = [];
    window.addEventListener('keydown', (e) => w.__g1Keys.push(`${e.metaKey ? 'Meta+' : ''}${e.key}`), true);
  });
  const frameKeys = () => webFrame.evaluate(() => (window as unknown as { __g1Keys: string[] }).__g1Keys);

  // 2. 按 ⌘B（焦点在网页里）：按键进了网页，白板页面收不到，面板不动——所以要靠应用菜单
  await clickPage();
  await pressInFrame(page, webFrame, 'b');
  await expect.poll(frameKeys).toEqual(['Meta+b']);
  await page.waitForTimeout(500);
  expect(await topKeys()).toEqual([]);
  expect(await panelOpen()).toBe(true);
  // 后台：快捷键注册成应用菜单的 accelerator；菜单项触发后（焦点仍在网页里）面板收起，再来一次展开
  await clickMenuAccelerator(deck, 'CmdOrCtrl+B');
  await expect.poll(panelOpen).toBe(false);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
  await clickPage();
  await clickMenuAccelerator(deck, 'CmdOrCtrl+B');
  await expect.poll(panelOpen).toBe(true);
  await expect.poll(async () => (await sends(deck)).filter((s) => s.channel === 'agentdeck-desktop:shortcut').map((s) => s.arg)).toEqual(['toggle-panel', 'toggle-panel']);
  await deck.screenshot('cmd-b');

  // ⌘0：缩放回 100%
  await setView({ x: 0, y: 0, zoom: 0.7 });
  await clickPage();
  await clickMenuAccelerator(deck, 'CmdOrCtrl+0');
  await expect.poll(async () => (await viewport(deck)).zoom).toBeCloseTo(1, 2);

  // ⌘1：Show all，所有窗口都放进视口
  await setView({ x: 300, y: 200, zoom: 1 });
  await clickPage();
  const before = await viewport(deck);
  await clickMenuAccelerator(deck, 'CmdOrCtrl+1');
  await expect.poll(async () => JSON.stringify(await viewport(deck))).not.toBe(JSON.stringify(before));
  await expect
    .poll(async () => {
      const pane = (await page.locator('.react-flow__pane').boundingBox())!;
      const panel = (await page.locator('aside.ad-panel').boundingBox())!;
      for (const id of [browserId!, claude.windowId]) {
        const b = await deck.windowEl(id).boundingBox();
        if (!b || b.x < pane.x || b.y < pane.y || b.x + b.width > panel.x || b.y + b.height > pane.y + pane.height) return false;
      }
      return true;
    })
    .toBe(true);
  await deck.screenshot('cmd-1');

  await setView({ x: 0, y: 0, zoom: 1 });
  // 3. 在网页里按 ⌘R（键盘进网页）：只刷新这个网页（dev server 多收到一个请求），不重载整个应用
  await clickPage();
  const n = requests();
  const boardBefore = await deck.board();
  await pressInFrame(page, webFrame, 'r');
  await expect.poll(requests).toBeGreaterThan(n);
  await expect(frame.locator('#hello')).toBeVisible();
  expect(await marker()).toBe(42);
  expect(await topKeys()).toEqual([]);
  expect((await deck.board()).windows.map((w) => w.id)).toEqual(boardBefore.windows.map((w) => w.id));
  // ⌘R 不在菜单里（不然会重载整个应用），那五个都在
  const accels = await deck.app.evaluate(({ Menu }) => {
    const out: string[] = [];
    const walk = (items: Electron.MenuItem[]) => {
      for (const i of items) {
        if (i.accelerator) out.push(String(i.accelerator));
        if (i.submenu) walk(i.submenu.items);
      }
    };
    walk(Menu.getApplicationMenu()?.items ?? []);
    return out;
  });
  expect(accels).not.toContain('CmdOrCtrl+R');
  for (const a of ['CmdOrCtrl+J', 'CmdOrCtrl+B', 'CmdOrCtrl+W', 'CmdOrCtrl+0', 'CmdOrCtrl+1']) expect(accels).toContain(a);

  await setView({ x: 0, y: 0, zoom: 1 });
  // ⌘J：跳到在等你的终端
  await clickPage();
  await clickMenuAccelerator(deck, 'CmdOrCtrl+J');
  await expect.poll(async () => (await deck.board()).focusedId).toBe(claude.windowId);
  await expect(deck.windowEl(claude.windowId).locator('.ad-window-flash')).toHaveCount(1);
  expect(await deck.status(claude.terminalId)).toBe('needs-approval');

  await setView({ x: 0, y: 0, zoom: 1 });
  // ⌘W：关掉焦点所在的网页窗口
  await clickPage();
  await clickMenuAccelerator(deck, 'CmdOrCtrl+W');
  await expect(deck.windowEl(browserId!)).toHaveCount(0);
  await expect.poll(async () => (await deck.board()).windows.some((w) => w.id === browserId)).toBe(false);
  expect(await marker()).toBe(42);
  expect((await sends(deck)).filter((s) => s.channel === 'agentdeck-desktop:shortcut').map((s) => s.arg)).toEqual([
    'toggle-panel',
    'toggle-panel',
    'zoom-100',
    'show-all',
    'next-waiting',
    'close-window',
  ]);
  await deck.screenshot('cmd-w');
});
