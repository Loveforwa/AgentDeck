// 主进程的 browser 模块（线 5 · U1 U3）。职责：
// 1. 实现 contracts 的 BrowserService（prepare / fileUrl / openExternal / ping），注册到 IPC 注册表上。
// 2. 响应头改写：prepare 过的本地来源（localhost、127.0.0.1、[::1]……）作为 iframe 加载时，
//    去掉 X-Frame-Options 和 CSP 里的 frame-ancestors，否则 dev server 的页面嵌不进白板。其他网站不动。
// 3. agentdeck-file:// 协议：本地 HTML 文件通过它打开，只能读用户打开过的文件所在目录及子目录（防路径穿越、符号链接逃逸）。
// 4. 往白板里网页窗口的 iframe 注入小桥脚本（bridge.ts），让界面知道 iframe 里的地址、能后退前进。
//
// 纯逻辑在 service.ts、headers.ts、origins.ts、local-files.ts、bridge.ts，测试在 apps/desktop/test/browser/。
// 这个文件只负责接 Electron。
//
// 组装（apps/desktop/src/main/index.ts）时调用：
//   registerBrowserService(registry);   // app ready 之前或之后调都可以，钩子等 ready 后装
// 组装时还要改 apps/desktop 的这几处（线 5 不能改那些文件）：
// - 界面页面的 CSP（src/renderer/index.html 的 default-src 'self'）会拦掉 iframe，要加
//   frame-src http: https: agentdeck-file:
// - session.webRequest.onHeadersReceived 每个 session 只能有一个监听；别的模块也要改响应头时，需要合并到一起。
// - 应用菜单不要把 ⌘R（Electron 默认菜单是重新加载整个应用）、⌘[、⌘]、⌘L 占掉，网页窗口自己处理。
// - setWindowOpenHandler 现在一律 deny：嵌入页面里的 window.open（例如 OAuth 弹窗）打不开，MVP 里用 Open in browser。
// - P1 的 webview 模式要在应用窗口开 webviewTag，并在 will-attach-webview 里锁住 preload 和 webPreferences。
// agentdeck-file 协议注册成非 standard，不需要 registerSchemesAsPrivileged（Electron 45 实测）。

import { realpath, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { app, net, session as electronSession, shell, webContents, webFrameMain } from 'electron';
import type { Session, WebContents } from 'electron';
import { LOCAL_FILE_SCHEME } from '@agentdeck/contracts';
import type { ServiceRegistry } from '../registry.ts';
import { BRIDGE_SCRIPT, isBoardFrame } from './bridge.ts';
import { pingFetch } from './ping-fetch.ts';
import { createBrowserService, publicBrowserService, type BrowserCore } from './service.ts';

export { createBrowserService, publicBrowserService, type BrowserCore } from './service.ts';

export interface RegisterBrowserOptions {
  /** 白板页面所在的 session，默认 session.defaultSession。 */
  session?: Session;
}

export function registerBrowserService(
  registry: Pick<ServiceRegistry, 'register'>,
  options: RegisterBrowserOptions = {},
): BrowserCore {
  const core = createBrowserService({
    openExternal: (url) => shell.openExternal(url),
    // ping 带 redirect: 'manual'，net.fetch 遇到跳转会抛错，改走 net.request（ping-fetch.ts，IS-43）
    fetch: pingFetch(
      (opts) => net.request(options.session ? { ...opts, session: options.session } : opts),
      (input, init) => net.fetch(input as string, { ...init, bypassCustomProtocolHandlers: true }),
    ),
    realpath: (path) => realpath(path),
    stat: (path) => stat(path),
  });
  registry.register('browser', publicBrowserService(core));

  const install = () => {
    installOnSession(core, options.session ?? electronSession.defaultSession);
    for (const wc of webContents.getAllWebContents()) attachBridge(wc);
    app.on('web-contents-created', (_event, wc) => attachBridge(wc));
  };
  if (app.isReady()) install();
  else void app.whenReady().then(install);
  return core;
}

export function installOnSession(core: BrowserCore, ses: Session): void {
  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = core.rewriteHeaders(details);
    callback(responseHeaders === null ? {} : { responseHeaders });
  });

  ses.protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const resolved = await core.resolveFile(request.url);
    if ('status' in resolved) {
      const text = resolved.status === 404 ? 'File not found' : resolved.status === 403 ? 'Forbidden' : 'Bad request';
      return new Response(text, { status: resolved.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return net.fetch(pathToFileURL(resolved.path).href, { headers: request.headers, bypassCustomProtocolHandlers: true });
  });
}

/** 只管应用自己的窗口（白板页面），不管 webview 和别的 webContents。 */
function attachBridge(wc: WebContents): void {
  if (wc.getType() !== 'window') return;

  wc.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (frame === undefined || frame.isDestroyed()) return;
    const parentIsBoard = frame.parent?.frameTreeNodeId === wc.mainFrame.frameTreeNodeId;
    if (isBoardFrame({ name: frame.name, parentIsBoard })) frame.executeJavaScript(BRIDGE_SCRIPT).catch(() => {});
  });
}
