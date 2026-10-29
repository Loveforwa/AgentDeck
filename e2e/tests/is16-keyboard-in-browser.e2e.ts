// IS-16（TC-18 的真键盘部分）：焦点在网页窗口里时，用键盘（Playwright 的 page.keyboard，不是菜单项、不是连到 frame 的 CDP 会话）按快捷键。
// page.keyboard 的按键和真键盘一样进了焦点所在的网页（跨源 iframe），白板页面一个 keydown 也收不到：
// - ⌘R：网页里的小桥收到，只刷新这个网页（dev server 多一个请求），应用没重载、白板上的窗口没变；
// - ⌘B ⌘J ⌘W ⌘0 ⌘1：网页收到，白板页面收不到，所以只能靠应用菜单的 accelerator（TC-18 已核对菜单这一段）；
//   网页和 AgentDeck 注进去的小桥都没 preventDefault 它们（对照：⌘[ 被小桥拦下），浏览器才会把它们当“没处理”交还给应用。
// 做不到的一段：真键盘 → macOS → 应用菜单。CDP 合成的按键没有系统事件，Electron 不交给菜单——焦点在白板页面里、白板不处理的 ⌘ 键
// 也一样到不了菜单（2026-10-29 试过，见报告）；用系统级按键（CGEventPostToPid）要辅助功能权限，本机没有，也不该替用户开。要人用真键盘试一次。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '../support/fixtures.ts';
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

test('IS-16 with focus inside a web page, the keyboard goes to the page: ⌘R reloads only that page, the board never sees ⌘B ⌘J ⌘W ⌘0 ⌘1', async ({ deck, sb }) => {
  const page = await deck.launch();
  const port = await freePort();
  const log = join(sb.root, 'requests.log');
  const requests = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  server = spawn(process.execPath, [join(E2E_DIR, 'fake-agent/dev-server.mjs'), String(port), log], { stdio: 'ignore' });
  const url = `http://localhost:${port}/`;
  await expect.poll(async () => fetch(url).then((r) => r.ok, () => false)).toBe(true);
  const browserId = await page.evaluate(
    (url) =>
      (window as unknown as { __board: { openWindow(from: null, req: object): string | null } }).__board.openWindow(null, {
        type: 'browser',
        data: { url },
        workspaceId: null,
        rect: { x: 40, y: 40, w: 520, h: 360 },
      }),
    url,
  );
  expect(browserId).not.toBeNull();
  const frame = deck.windowEl(browserId!).frameLocator('iframe.ad-browser__frame');
  await expect(frame.locator('#hello')).toBeVisible();
  await page.keyboard.press('Meta+0');
  await page.evaluate(() => ((window as unknown as { __h2Marker: number }).__h2Marker = 7));
  const marker = () => page.evaluate(() => (window as unknown as { __h2Marker?: number }).__h2Marker ?? null);

  // 两边都记下收到的 keydown
  const install = () => {
    const w = window as unknown as { __h2Keys: string[] };
    w.__h2Keys = [];
    window.addEventListener('keydown', (e) => w.__h2Keys.push(`${e.metaKey ? 'Meta+' : ''}${e.key}`), true);
    // 冒泡到最后、别的监听都跑完以后再看有没有被 preventDefault：没被拦的按键浏览器才当“页面没处理”交还给 Electron（macOS 上再给菜单）
    const v = window as unknown as { __h2Prevented: string[] };
    v.__h2Prevented = [];
    window.addEventListener('keydown', (e) => setTimeout(() => e.defaultPrevented && v.__h2Prevented.push(e.key)));
  };
  await page.evaluate(install);
  const topKeys = () => page.evaluate(() => (window as unknown as { __h2Keys: string[] }).__h2Keys);
  const webFrame = () => {
    const f = page.frames().find((x) => x.url().startsWith(url));
    if (!f) throw new Error('web page frame not found');
    return f;
  };
  await webFrame().evaluate(install);
  const frameKeys = () => webFrame().evaluate(() => (window as unknown as { __h2Keys?: string[] }).__h2Keys ?? []);

  // 1. 单击网页内容：焦点进网页（第一下只聚焦窗口，第二下进 iframe）
  const clickPage = async () => {
    const inside = () => page.evaluate(() => document.activeElement?.tagName === 'IFRAME');
    await frame.locator('#hello').click({ delay: 80, position: { x: 20, y: 10 } });
    if (!(await inside())) await frame.locator('#hello').click({ delay: 80, position: { x: 20, y: 10 } });
    await expect.poll(inside).toBe(true);
    await expect.poll(async () => (await deck.board()).focusedId).toBe(browserId);
  };
  await clickPage();

  // 2. 键盘按 ⌘J ⌘B ⌘W ⌘0 ⌘1：都进了网页，白板页面收不到（窗口还在，因为 ⌘W 只能经菜单关）
  for (const k of ['j', 'b', 'w', '0', '1']) await page.keyboard.press(`Meta+${k}`);
  await expect.poll(async () => (await frameKeys()).filter((k) => k !== 'Meta+Meta')).toEqual(['Meta+j', 'Meta+b', 'Meta+w', 'Meta+0', 'Meta+1']);
  await page.waitForTimeout(500);
  expect(await topKeys()).toEqual([]);
  // 网页（和 AgentDeck 注进去的小桥）都没拦这几个键：⌘[ ⌘] ⌘R ⌘L 以外的 ⌘ 键原样交还给应用
  const prevented = () => webFrame().evaluate(() => (window as unknown as { __h2Prevented: string[] }).__h2Prevented);
  expect(await prevented()).toEqual([]);
  // 对照：⌘[ 是网页窗口自己的（后退，这里没有历史，什么也不变），小桥拦下了，记录得到
  await page.keyboard.press('Meta+BracketLeft');
  await expect.poll(prevented).toEqual(['[']);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
  await deck.screenshot('keys-in-page');

  // 3. 键盘按 ⌘R：只刷新这个网页，不重载整个应用
  const n = requests();
  const before = (await deck.board()).windows.map((w) => w.id);
  await page.keyboard.press('Meta+r');
  await expect.poll(requests).toBeGreaterThan(n);
  await expect(frame.locator('#hello')).toBeVisible();
  expect(await marker()).toBe(7);
  expect(await topKeys()).toEqual([]);
  expect((await deck.board()).windows.map((w) => w.id)).toEqual(before);
  // 刷新后的新页面（新的 frame）照样收键盘：再按一次 ⌘R，又刷新一次
  await clickPage();
  const m = requests();
  await page.keyboard.press('Meta+r');
  await expect.poll(requests).toBeGreaterThan(m);
  expect(await marker()).toBe(7);
  await deck.screenshot('after-reload');
});
