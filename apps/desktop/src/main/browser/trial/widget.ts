// 端到端试验：网页窗口的 dev 页面 + 真的 browser 模块（registerBrowserService：响应头改写、小桥注入、agentdeck-file://）。
// 不经过应用的 IPC（组装是第 3 波的事），用一个只给试验的 preload 把服务交给页面。
//
// 跑法（仓库根目录）：
//   apps/desktop/node_modules/.bin/electron apps/desktop/src/main/browser/trial/widget.ts
// 会自己起网页窗口包的 vite dev server（5330，连带 5331 / 5332 登录服务）；已经起着就直接用。
// 加 SHOW=1 显示窗口并且跑完不退出，可以自己点。

import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, type WebFrameMain } from 'electron';
import { createServer, type ViteDevServer } from 'vite';
import type { BrowserService } from '@agentdeck/contracts';
import { registerBrowserService } from '../index.ts';
import { keepAliveWhenWindowsClose, runTrial } from './shutdown.ts';

const DEV_PAGE = 'http://localhost:5330/';
const WIDGET_DIR = join(import.meta.dirname, '../../../../../../packages/ui/widgets/browser');
const show = process.env['SHOW'] === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 自己起的 dev server，跑完要关掉，否则文件监听会让进程退不出去。已经起着的返回 null。 */
async function ensureDevServer(): Promise<ViteDevServer | null> {
  try {
    await fetch(DEV_PAGE);
    return null;
  } catch {
    // 没起，自己起
  }
  const server = await createServer({ configFile: join(WIDGET_DIR, 'vite.config.ts'), logLevel: 'warn' });
  await server.listen();
  return server;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 6000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && (v as unknown) !== false) return v;
    } catch {
      // 页面还在切换
    }
    await sleep(100);
  }
  return null;
}

if (show) {
  keepAliveWhenWindowsClose();
  void app.whenReady().then(trial);
} else {
  runTrial(trial);
}

async function trial(): Promise<(() => Promise<unknown>)[]> {
  const devServer = await ensureDevServer();
  let service: Partial<BrowserService> = {};
  registerBrowserService({ register: (_name, impl) => void (service = impl as Partial<BrowserService>) });
  ipcMain.handle('agentdeck-trial:browser', (_event, method: keyof BrowserService, args: unknown[]) =>
    (service[method] as (...a: unknown[]) => unknown)(...args),
  );

  const win = new BrowserWindow({
    show,
    width: 1280,
    height: 860,
    webPreferences: {
      preload: join(import.meta.dirname, 'widget-preload.mjs'),
      contextIsolation: true,
      // ESM preload 不能在 sandbox 里跑；只是试验窗口。
      sandbox: false,
    },
  });
  await win.loadURL(DEV_PAGE);

  const page = (code: string) => win.webContents.executeJavaScript(code) as Promise<unknown>;
  const frames = () => win.webContents.mainFrame.frames;
  const frameAt = (i: number): WebFrameMain | null => frames()[i] ?? null;
  const inFrame = async (i: number, code: string) => frameAt(i)?.executeJavaScript(code);
  const clickButton = (text: string) =>
    page(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const addresses = () =>
    page(`[...document.querySelectorAll('.ad-browser__address')].map((i) => i.value)`) as Promise<string[]>;
  const results: Record<string, unknown> = {};

  // 1. 第一个窗口：localhost:5332（不拒绝嵌入）
  results['5332 shown'] = await waitFor(() => inFrame(0, `document.querySelector('h1')?.textContent`));
  results['real service'] = await page(`document.querySelector('.dev-header').innerText`);

  // 2. localhost:5331 带 X-Frame-Options: DENY 和 frame-ancestors 'none'：改写后应能显示
  await clickButton('localhost:5331 (X-Frame-Options)');
  results['5331 shown (XFO rewritten)'] = await waitFor(() => inFrame(1, `document.querySelector('h1')?.textContent`));

  // 3. iframe 里点链接 → 小桥报地址 → 地址栏、data.url 跟上，Back 可用
  await inFrame(1, `document.querySelector('a[href="/about"]').click()`);
  results['address after in-frame click'] = await waitFor(async () =>
    (await addresses()).find((a) => a.includes('5331/about')),
  );
  results['back enabled'] = await page(
    `!document.querySelectorAll('.ad-browser')[1].querySelector('[aria-label="Back"]').disabled`,
  );
  await page(`document.querySelectorAll('.ad-browser')[1].querySelector('[aria-label="Back"]').click()`);
  results['after Back'] = await waitFor(async () => (await addresses()).find((a) => a === 'localhost:5331'));

  // 4. SPA 的 pushState
  await inFrame(1, `document.querySelector('a[href="/spa"]').click()`);
  await sleep(500);
  await inFrame(1, `document.getElementById('go').click()`);
  results['address after pushState'] = await waitFor(async () =>
    (await addresses()).find((a) => a.includes('spa?step=1')),
  );

  // 5. 登录（dev 页面在 localhost:5330，和 5331 同站；file:// 宿主的情况见 risk3.ts）
  await inFrame(1, `location.href = '/'`);
  await sleep(500);
  await inFrame(1, `document.querySelector('form').submit()`);
  results['signed in'] = await waitFor(() => inFrame(1, `document.querySelector('h1')?.dataset.state === 'signed-in'`));

  // 6. 没有服务的地址 → 出错页
  await clickButton('localhost:5399 (nothing running)');
  results['unreachable page'] = await waitFor(() =>
    page(`[...document.querySelectorAll('.ad-browser__message-title')].map((p) => p.textContent).join(' | ') || null`),
  );

  // 7. 本地文件：相对路径的 css 能加载；文件不存在时 File not found
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agentdeck-widget-')));
  await writeFile(join(dir, 'style.css'), 'h1 { letter-spacing: 3px; }');
  await writeFile(join(dir, 'Report.html'), '<!doctype html><link rel="stylesheet" href="style.css"><h1>Local report</h1>');
  const openFile = async (path: string) => {
    await page(`(() => {
      const input = document.querySelector('.dev-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(path)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(100);
    await clickButton('Open file');
  };
  await openFile(join(dir, 'Report.html'));
  results['local file'] = await waitFor(async () => {
    const f = frames().find((x) => x.url.startsWith('agentdeck-file:'));
    return f?.executeJavaScript(
      `document.querySelector('h1').textContent + ' / letter-spacing ' + getComputedStyle(document.querySelector('h1')).letterSpacing`,
    );
  });
  results['local file address'] = (await addresses()).find((a) => a.endsWith('Report.html'));
  await openFile(join(dir, 'Gone.html'));
  results['missing file'] = await waitFor(() =>
    page(`[...document.querySelectorAll('.ad-browser__message-title')].some((p) => p.textContent === 'File not found')`),
  );

  // 8. 缩放：把白板缩到 60% 截个图
  await page(`(() => {
    const range = document.querySelector('input[type=range]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(range, '0.6');
    range.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(800);
  const shot = join(dir, 'widget.png');
  await writeFile(shot, (await win.webContents.capturePage()).toPNG());
  results['screenshot'] = shot;

  console.log(JSON.stringify(results, null, 2));
  return devServer === null ? [] : [() => devServer.close()];
}
