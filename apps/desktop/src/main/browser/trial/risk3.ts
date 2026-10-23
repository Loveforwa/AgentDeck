// 风险 3 的试验：嵌进白板的本地页面能不能保持登录。结论写在 packages/ui/widgets/browser/AGENTS.md。
// 顺带实测 browser 模块本身：响应头改写、小桥脚本、agentdeck-file:// 和路径检查、<webview> 能不能跟着 CSS 缩放。
//
// 跑法（仓库根目录）：
//   apps/desktop/node_modules/.bin/electron apps/desktop/src/main/browser/trial/risk3.ts
// 不需要先起 dev server：脚本自己在 5341（带 X-Frame-Options: DENY 的登录页）和 5343（宿主页面）起服务，跑完退出。
// 截图写到系统临时目录，路径会打印出来。
//
// 宿主页面两种：file://（和打包后的应用一样）、http://localhost:5343（和 electron-vite dev 一样）。
// 嵌入方式三种：
//   iframe-no-cookie-fix  只去掉 X-Frame-Options / frame-ancestors
//   iframe                现在的做法：再把 Set-Cookie 改成 SameSite=None; Secure（installOnSession）
//   webview               <webview>，独立 partition，不改响应头

import { mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, session, webContents, type Session, type WebFrameMain } from 'electron';
import { createLoginApp } from '../../../../../../packages/ui/widgets/browser/dev/login-app.ts';
import { BOARD_FRAME_NAME_PREFIX, BRIDGE_SCRIPT } from '../bridge.ts';
import { stripFrameBlockingHeaders } from '../headers.ts';
import { installOnSession } from '../index.ts';
import { createBrowserService, type BrowserCore } from '../service.ts';

const FRAME_NAME = `${BOARD_FRAME_NAME_PREFIX}trial`;
const HOST_ORIGIN = 'http://localhost:5343';

type Embed = 'iframe-no-cookie-fix' | 'iframe' | 'webview';
type Host = 'file' | 'localhost';

const hostPages = new Map<string, string>();
let tempDir = '';

/** localhost 和 127.0.0.1 都要能连上，所以 IPv4、IPv6 各起一个。 */
async function serve(port: number, handler: RequestListener): Promise<void> {
  for (const host of ['127.0.0.1', '::1']) {
    await new Promise<void>((resolve) => createServer(handler).listen(port, host, resolve));
  }
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 5000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined) return v;
    } catch {
      // 页面还在切换，重试
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hostHtml(body: string): string {
  return `<!doctype html><html><body style="margin:0">${body}
<script>window.__msgs=[];addEventListener('message',(e)=>window.__msgs.push(e.data));</script></body></html>`;
}

function embedHtml(embed: Embed, src: string, partition: string): string {
  return embed === 'webview'
    ? `<webview id="f" src="${src}" partition="${partition}" style="width:600px;height:400px"></webview>`
    : `<iframe id="f" name="${FRAME_NAME}" src="${src}" width="600" height="400"></iframe>`;
}

async function openHost(win: BrowserWindow, host: Host, name: string, html: string): Promise<void> {
  if (host === 'file') {
    const file = join(tempDir, name);
    await writeFile(file, html);
    await win.loadFile(file);
  } else {
    hostPages.set(`/${name}`, html);
    await win.loadURL(`${HOST_ORIGIN}/${name}`);
  }
}

function newWindow(ses: Session): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { session: ses, webviewTag: true, sandbox: true, contextIsolation: true },
  });
  // 和 index.ts 的 attachBridge 一样往白板 iframe 里注入小桥（这里的窗口不是用 registerBrowserService 装的）。
  win.webContents.on('did-frame-finish-load', (_e, isMain) => {
    if (!isMain) void frameOf(win)?.executeJavaScript(BRIDGE_SCRIPT).catch(() => {});
  });
  return win;
}

/** 按 name 找白板 iframe；跨进程导航后 WebFrameMain 会换，所以每次重新找。 */
function frameOf(win: BrowserWindow): WebFrameMain | null {
  return win.webContents.mainFrame.frames.find((f) => f.name === FRAME_NAME) ?? null;
}

/** 在嵌入的页面里执行脚本：iframe 用 WebFrameMain，webview 用它自己的 webContents。 */
function runner(win: BrowserWindow, embed: Embed): (code: string) => Promise<unknown> {
  if (embed !== 'webview') {
    return async (code) => {
      const f = frameOf(win);
      if (f === null) throw new Error('no frame');
      return f.executeJavaScript(code);
    };
  }
  return async (code) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.hostWebContents === win.webContents);
    if (guest === undefined) throw new Error('no webview');
    return guest.executeJavaScript(code);
  };
}

function newCore(ses: Session, embed: Embed): BrowserCore {
  const core = createBrowserService({ openExternal: async () => {}, realpath, stat });
  installOnSession(core, ses);
  if (embed === 'iframe-no-cookie-fix') {
    // 覆盖 installOnSession 装的监听（每个 session 只能有一个），只去掉 X-Frame-Options / frame-ancestors。
    ses.webRequest.onHeadersReceived((details, callback) => {
      const ok = details.resourceType === 'subFrame' && core.allowedOrigins.allows(details.url);
      const responseHeaders = ok ? stripFrameBlockingHeaders(details.responseHeaders ?? {}) : null;
      callback(responseHeaders === null ? {} : { responseHeaders });
    });
  }
  return core;
}

interface LoginResult {
  host: Host;
  embed: Embed;
  page: string;
  shown: boolean;
  signedIn: boolean;
  fetchSignedIn: boolean;
  afterReload: boolean;
  jsCookie: boolean;
  stored: string;
}

let counter = 0;

async function loginScenario(host: Host, embed: Embed, page: string): Promise<LoginResult> {
  const n = counter++;
  const ses = session.fromPartition(`trial-host-${n}`);
  const core = newCore(ses, embed);
  await core.prepare(page);
  const partition = `trial-guest-${n}`;
  const win = newWindow(ses);
  await openHost(win, host, `login-${n}.html`, hostHtml(embedHtml(embed, page, partition)));

  const run = runner(win, embed);
  const state = () => run(`document.querySelector('h1')?.dataset.state ?? null`) as Promise<string | null>;
  const signedIn = async () => (await waitFor(async () => ((await state()) === 'signed-in' ? true : null), 3000)) === true;
  const result: LoginResult = {
    host,
    embed,
    page,
    shown: (await waitFor(state)) !== null,
    signedIn: false,
    fetchSignedIn: false,
    afterReload: false,
    jsCookie: false,
    stored: '',
  };
  if (result.shown) {
    await run(`document.querySelector('form').submit()`);
    result.signedIn = await signedIn();
    result.fetchSignedIn =
      (await run(`fetch('/api/me', { credentials: 'include' }).then((r) => r.json()).then((j) => j.signedIn)`)) === true;
    await run('location.reload()');
    await sleep(300);
    result.afterReload = await signedIn();
    // 页面自己用 document.cookie 写的 cookie 不经过响应头，改写管不到。
    result.jsCookie =
      (await run(`document.cookie = 'js_sid=1; path=/; SameSite=Lax'; document.cookie.includes('js_sid=1')`)) === true;
  }
  const cookieSession = embed === 'webview' ? session.fromPartition(partition) : ses;
  result.stored = (await cookieSession.cookies.get({ url: page }))
    .filter((c) => c.name === 'trial_sid')
    .map((c) => `sameSite=${c.sameSite}${c.secure ? ' secure' : ''}`)
    .join(', ');
  win.destroy();
  return result;
}

/** 白板会对整层做 transform: scale()。iframe 跟着缩放；看 <webview> 是不是也跟着。截图给人看。 */
async function scaleCheck(): Promise<string> {
  const ses = session.fromPartition('trial-scale');
  const core = newCore(ses, 'iframe');
  const page = 'http://localhost:5341/about';
  await core.prepare(page);
  const win = newWindow(ses);
  const box = (inner: string) =>
    `<div style="display:inline-block;width:300px;height:200px;vertical-align:top;outline:1px solid">
<div style="transform:scale(0.5);transform-origin:0 0">${inner}</div></div>`;
  await openHost(
    win,
    'file',
    'scale.html',
    hostHtml(box(embedHtml('iframe', page, '')) + box(embedHtml('webview', page, 'trial-scale-guest'))),
  );
  await sleep(2000);
  const file = join(tempDir, 'scale.png');
  await writeFile(file, (await win.webContents.capturePage()).toPNG());
  win.destroy();
  return file;
}

/** 模块自检：小桥报地址（含 pushState）、出错页、没进名单的来源不改写、agentdeck-file:// 的读取和越界。 */
async function moduleChecks(): Promise<Record<string, unknown>> {
  const ses = session.fromPartition('trial-module');
  const core = newCore(ses, 'iframe');
  const site = join(tempDir, 'site');
  await mkdir(site, { recursive: true });
  await writeFile(join(tempDir, 'secret.txt'), 'secret');
  await writeFile(join(site, 'style.css'), 'h1 { color: rgb(255, 0, 0); }');
  await writeFile(
    join(site, 'Report.html'),
    `<!doctype html><link rel="stylesheet" href="style.css"><h1>Report</h1>
<script>fetch('../secret.txt').then((r) => r.status, () => 'blocked').then((s) => (document.body.dataset.secret = String(s)));</script>`,
  );
  const fileSrc = (await core.prepare(join(site, 'Report.html'))).src;
  await core.prepare('http://localhost:5341/');

  const out: Record<string, unknown> = { fileSrc };
  const win = newWindow(ses);
  const messages = async () => (await win.webContents.executeJavaScript('window.__msgs')) as Record<string, unknown>[];
  const hrefs = async () => (await messages()).filter((m) => m['type'] === 'location').map((m) => m['href']);
  const load = async (host: Host, src: string) => {
    await openHost(win, host, 'module.html', hostHtml(embedHtml('iframe', src, '')));
    await sleep(1200);
  };

  await load('file', 'http://localhost:5341/spa');
  await frameOf(win)?.executeJavaScript(`document.getElementById('go').click()`);
  await sleep(300);
  out['bridgeSpa'] = await hrefs();

  await load('file', 'http://localhost:5349/'); // 没有服务
  out['unreachable'] = await hrefs();

  await load('file', 'http://127.0.0.1:5341/'); // 没 prepare 过的来源：响应头不改，应被拒
  out['notAllowListed'] = await hrefs();

  for (const host of ['file', 'localhost'] as const) {
    await load(host, fileSrc);
    out[`file-in-${host}-host`] = {
      hrefs: await hrefs(),
      cssApplied: await frameOf(win)?.executeJavaScript(`getComputedStyle(document.querySelector('h1')).color`),
      fetchOutsideRoot: await frameOf(win)?.executeJavaScript(`document.body.dataset.secret`),
    };
  }
  out['resolveTraversal'] = await core.resolveFile(fileSrc.replace('Report.html', '../secret.txt'));
  out['resolveEncodedTraversal'] = await core.resolveFile(fileSrc.replace('Report.html', '%2e%2e/secret.txt'));
  out['resolveOutside'] = await core.resolveFile('agentdeck-file:///etc/passwd');
  out['pingDown'] = await core.ping('http://localhost:5349/');
  out['pingUp'] = await core.ping('http://localhost:5341/');
  out['pingMissingFile'] = await core.ping(join(site, 'gone.html'));
  win.destroy();
  return out;
}

// 每个场景关掉窗口后不要退出应用。
app.on('window-all-closed', () => {});

void app.whenReady().then(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'agentdeck-risk3-')));
  await serve(5341, createLoginApp({ denyFraming: true, label: 'trial 5341' }));
  await serve(5343, (req, res) => {
    const html = hostPages.get(new URL(req.url ?? '/', HOST_ORIGIN).pathname);
    res.statusCode = html === undefined ? 404 : 200;
    res.setHeader('content-type', 'text/html');
    res.end(html ?? 'not found');
  });

  const results: LoginResult[] = [];
  for (const host of ['file', 'localhost'] as const) {
    for (const embed of ['iframe-no-cookie-fix', 'iframe', 'webview'] as const) {
      results.push(await loginScenario(host, embed, 'http://localhost:5341/'));
    }
  }
  results.push(await loginScenario('file', 'iframe', 'http://127.0.0.1:5341/'));
  results.push(await loginScenario('file', 'iframe', 'http://[::1]:5341/'));
  console.log('\n== risk 3: login ==');
  console.table(results);
  console.log('\n== scale screenshot (left iframe, right webview, both inside scale(0.5)) ==');
  console.log(await scaleCheck());
  console.log('\n== module checks ==');
  console.log(JSON.stringify(await moduleChecks(), null, 2));
  console.log(`electron ${process.versions.electron}, chrome ${process.versions.chrome}`);
  app.exit(0);
});
