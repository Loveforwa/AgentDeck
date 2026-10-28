// TC-27：网页窗口打开会跳转的地址，不误报 “isn’t responding”（ping 收到 301/302 就算有响应，不跟过去）。
// TC-28：外部网站在白板里用 webview 显示、能登录、重启后还登录着、第三方登录弹窗用同一个分区、⌘[ ⌘] ⌘R、跟着白板缩放。
//
// 不联网：外部网站由 fake-agent/web-server.mjs 模仿（按 Host 分站），AgentDeck 启动时带
//   --host-resolver-rules：*.test 解析到 127.0.0.1，其余一律解析失败（保证碰不到真网站）；
//   --no-proxy-server：不走系统代理（本机有 127.0.0.1:7897 的代理，走它就会出网）。
// *.test 不是 localhost，AgentDeck 把它们当外部网站（webview）；localhost 那个当 dev server（iframe）。
// 只能人工的：真的 google.com、github.com 登录（要自己的账号），Google 登录不提示 “This browser or app may not be secure”。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { shieldRealAgents } from '../support/g4-env.ts';
import { E2E_DIR } from '../support/sandbox.ts';

const WEB_PARTITION = 'persist:agentdeck-web';
const NO_NETWORK = ['--host-resolver-rules=MAP *.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost', '--no-proxy-server'];

interface Hit {
  n: number;
  host: string;
  method: string;
  path: string;
  ua: string;
  dest: string;
  cookie: string;
}

let server: ChildProcess | null = null;
let port = 0;
let logFile = '';

test.beforeEach(async ({ sb }) => {
  shieldRealAgents(sb);
  logFile = join(sb.root, 'web.log');
  server = spawn(process.execPath, [join(E2E_DIR, 'fake-agent/web-server.mjs'), '0', logFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise<number>((resolve, reject) => {
    server!.stdout!.on('data', (c: Buffer) => {
      const m = /listening (\d+)/.exec(c.toString());
      if (m) resolve(Number(m[1]));
    });
    server!.once('exit', () => reject(new Error('web server exited')));
  });
});
test.afterEach(() => {
  server?.kill();
  server = null;
});

const hits = (): Hit[] => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Hit) : []);
/** 主进程的 ping（net.request，UA 带 Electron；白板 iframe 的请求 UA 也带，但 Sec-Fetch-Dest 是 iframe）。 */
const isPing = (h: Hit) => /Electron\//.test(h.ua) && h.dest !== 'iframe';
/** webview 里的请求（webview 分区的 UA 去掉了 Electron；http 的外部网站不带 Sec-Fetch-*，只能看 UA）。 */
const fromWebview = (h: Hit) => !/Electron\//.test(h.ua);
const at = (host: string, path = '/') => `http://${host}:${port}${path}`;

/** 右键 › New browser，在地址栏打一个地址回车（真的键盘），返回窗口 id。 */
async function openAddress(deck: Deck, url: string, known: string[] = []): Promise<string> {
  const page = deck.page;
  const p = await deck.emptyPoint(known.length ? 'bottom' : 'left');
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await deck.pickMenu(['New browser']);
  const id = await deck.waitForWindow((w) => w.type === 'browser', known);
  await deck.showAll();
  const address = deck.windowEl(id).getByRole('textbox', { name: 'Address' });
  await address.click();
  await page.keyboard.type(url, { delay: 5 });
  await page.keyboard.press('Enter');
  return id;
}

/** 白板上的 webview（主进程里的 guest webContents）。 */
async function guests(deck: Deck) {
  return deck.app.evaluate(({ webContents, session }, partition) =>
    webContents
      .getAllWebContents()
      .filter((w) => w.getType() === 'webview')
      .map((w) => ({ id: w.id, url: w.getURL(), samePartition: w.session === session.fromPartition(partition), ua: w.getUserAgent() })),
    WEB_PARTITION,
  );
}

async function guestEval<T>(deck: Deck, id: number, js: string): Promise<T> {
  return deck.app.evaluate(({ webContents }, { id, js }) => webContents.fromId(id)!.executeJavaScript(js, true), { id, js }) as Promise<T>;
}

async function guestFor(deck: Deck, re: RegExp): Promise<number> {
  let id = -1;
  await expect
    .poll(async () => {
      id = (await guests(deck)).find((g) => re.test(g.url))?.id ?? -1;
      return id;
    }, { timeout: 30_000, message: `webview showing ${re}` })
    .toBeGreaterThan(-1);
  return id;
}

/**
 * 在网页里按 ⌘<key>。Playwright 的键盘（CDP）只送到白板页面、进不了 webview（2026-10-28 实测：网页里收不到任何按键，
 * 主进程的 before-input-event 也不触发），所以从主进程对 webview 发真的按键事件（webContents.sendInputEvent），
 * 走的是和系统键盘一样的输入路径，AgentDeck 在 before-input-event 里处理。
 */
async function guestKey(deck: Deck, guest: number, key: string): Promise<void> {
  await deck.app.evaluate(({ webContents }, { id, key }) => {
    const g = webContents.fromId(id)!;
    g.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['meta'] });
    g.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['meta'] });
  }, { id: guest, key });
}

async function textIn(deck: Deck, guest: number, selector: string): Promise<string | null> {
  return guestEval<string | null>(deck, guest, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`).catch(() => null);
}

async function noErrorPage(page: Page, windowId: string) {
  const win = page.locator(`.ad-window-node[data-window-id="${windowId}"]`);
  await expect(win).not.toContainText('isn’t responding');
  await expect(win).not.toContainText('can’t be shown on the board');
}

test('TC-27 addresses that redirect are not reported as “isn’t responding”', async ({ deck }) => {
  await deck.launch({ args: NO_NETWORK });
  const page = deck.page;

  // 1. 地址栏输入会跳到 www 的外部地址（像 https://google.com/ → www.google.com）
  const ext = await openAddress(deck, at('example.test'));
  const guest = await guestFor(deck, /www\.example\.test/);
  await expect.poll(() => textIn(deck, guest, '#home')).toBe('Example home');
  await noErrorPage(page, ext);
  await expect(deck.windowEl(ext).locator('webview')).toHaveCount(1);
  await expect(deck.windowEl(ext).getByRole('textbox', { name: 'Address' })).toHaveValue(/www\.example\.test/);
  await expect.poll(async () => (await deck.board()).windows.find((w) => w.id === ext)?.data['url']).toBe(at('www.example.test'));
  await deck.screenshot('external-redirect');

  // 2. 本地 dev server 把 / 跳到 /login：iframe 跟着跳，正常显示
  const local = await openAddress(deck, at('localhost'), [ext]);
  const frame = deck.windowEl(local).frameLocator('iframe.ad-browser__frame');
  await expect(frame.locator('#login')).toHaveText('Dev server login');
  await noErrorPage(page, local);
  await expect.poll(async () => (await deck.board()).windows.find((w) => w.id === local)?.data['url']).toBe(at('localhost', '/login'));
  await deck.screenshot('local-redirect');

  // 后台：ping 只问了原地址、收到 301 / 302 就算有响应，没跟过去（跟过去的是页面自己）
  const pings = hits().filter(isPing);
  expect(pings.map((h) => `${h.host}${h.path}`)).toEqual(expect.arrayContaining(['example.test/', 'localhost/']));
  expect(pings.some((h) => h.host === 'www.example.test' || h.path === '/login')).toBe(false);
  expect(hits().some((h) => h.host === 'www.example.test' && fromWebview(h))).toBe(true);
});

test('TC-28 an external site in a webview: sign in, still signed in after restart, login popup, ⌘[ ⌘] ⌘R, zooms with the board', async ({ deck }) => {
  await deck.launch({ args: NO_NETWORK });
  let page = deck.page;

  // 1. 地址栏输入登录页（像 github.com/login），网页直接显示在窗口里（不是 “can’t be shown on the board”）
  const win = await openAddress(deck, at('app.test', '/login'));
  let guest = await guestFor(deck, /app\.test.*\/login/);
  await expect.poll(() => textIn(deck, guest, '#submit')).toBe('Sign in');
  await noErrorPage(page, win);
  // 后台：webview 用 persist:agentdeck-web 分区，UA 不带 Electron
  const g = (await guests(deck)).find((x) => x.id === guest)!;
  expect(g.samePartition).toBe(true);
  expect(g.ua).not.toMatch(/Electron\//);
  // 登录（表单提交；真网站的账号密码要人工）
  await guestEval(deck, guest, "document.getElementById('submit').click()");
  await expect.poll(() => textIn(deck, guest, '#me')).toBe('Signed in as e2e');
  // 网页自己的请求（不是 ping）都不带 Electron
  expect(hits().filter((h) => h.host === 'app.test' && !isPing(h)).length).toBeGreaterThan(0);
  expect(hits().filter((h) => h.host === 'app.test' && !isPing(h)).every(fromWebview)).toBe(true);
  await deck.screenshot('signed-in');

  // 2. 关掉 AgentDeck 再打开：还是登录状态（持久分区里的 cookie）
  await deck.quit();
  page = await deck.launch({ args: NO_NETWORK });
  guest = await guestFor(deck, /app\.test/);
  await expect.poll(() => textIn(deck, guest, '#me'), { timeout: 30_000 }).toBe('Signed in as e2e');
  await noErrorPage(page, win);
  await deck.screenshot('still-signed-in');

  // 3. 第三方登录弹窗（像 Google 的 Sign in）：先退出，再点 Sign in with Provider
  await guestEval(deck, guest, "location.href = '/logout'");
  await expect.poll(() => textIn(deck, guest, '#anon')).toBe('Not signed in');
  const popupOpened = deck.app.waitForEvent('window');
  await guestEval(deck, guest, "document.getElementById('popup').click()");
  const popup = await popupOpened;
  await expect(popup.locator('#authorize')).toBeVisible();
  // 后台：弹窗和网页窗口用同一个分区，UA 也不带 Electron
  const popupInfo = await deck.app.evaluate(({ webContents, session }, partition) => {
    const w = webContents.getAllWebContents().find((x) => x.getType() === 'window' && x.getURL().includes('auth.test'));
    return w ? { samePartition: w.session === session.fromPartition(partition), ua: w.getUserAgent() } : null;
  }, WEB_PARTITION);
  expect(popupInfo).toMatchObject({ samePartition: true });
  expect(popupInfo!.ua).not.toMatch(/Electron\//);
  await popup.locator('#allow').click();
  // 弹窗回到 app.test 设好 cookie 后自己关掉，网页窗口里变成登录状态
  await popup.waitForEvent('close', { timeout: 20_000 });
  await expect.poll(() => textIn(deck, guest, '#me'), { timeout: 20_000 }).toBe('Signed in as e2e');
  expect(hits().some((h) => h.host === 'app.test' && h.path === '/callback?code=granted')).toBe(true);

  // 4. ⌘[ ⌘] ⌘R：焦点在网页里（单击进去），按键见 guestKey
  await guestEval(deck, guest, "document.getElementById('page2').click()");
  await expect.poll(() => textIn(deck, guest, '#p2')).toBe('Page 2');
  await deck.focusWindow(win); // 第一下只聚焦窗口
  await expect(deck.windowEl(win).locator('.ad-window-cover')).toHaveCount(0);
  const box = (await deck.windowEl(win).locator('webview').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 80 }); // 第二下点进网页
  await expect.poll(() => guestEval<boolean>(deck, guest, 'document.hasFocus()')).toBe(true);
  await guestKey(deck, guest, '[');
  await expect.poll(() => textIn(deck, guest, '#me')).toBe('Signed in as e2e');
  await guestKey(deck, guest, ']');
  await expect.poll(() => textIn(deck, guest, '#p2')).toBe('Page 2');
  const before = hits().filter((h) => h.path === '/page2' && fromWebview(h)).length;
  await page.evaluate(() => ((window as unknown as { __e2eMark?: number }).__e2eMark = 1));
  await guestKey(deck, guest, 'R');
  await expect.poll(() => hits().filter((h) => h.path === '/page2' && fromWebview(h)).length).toBe(before + 1);
  // ⌘R 只刷新了网页，白板页面没重载
  expect(await page.evaluate(() => (window as unknown as { __e2eMark?: number }).__e2eMark)).toBe(1);

  // 5. 缩小白板：网页跟着缩放（webview 在 transform 里，画出来变小，网页自己的宽度不变）
  const webview = deck.windowEl(win).locator('webview');
  const wide = (await webview.boundingBox())!.width;
  const inner = await guestEval<number>(deck, guest, 'window.innerWidth');
  const zoom0 = (await deck.board()).viewport.zoom;
  await page.getByRole('button', { name: 'Zoom' }).click();
  await page.getByRole('menuitem', { name: /^50%/ }).click();
  await expect.poll(async () => (await deck.board()).viewport.zoom).toBeCloseTo(0.5, 2);
  await expect.poll(async () => (await webview.boundingBox())!.width / wide, { timeout: 10_000 }).toBeCloseTo(0.5 / zoom0, 1);
  expect(await guestEval<number>(deck, guest, 'window.innerWidth')).toBe(inner);
  await deck.screenshot('zoomed-out');
});
