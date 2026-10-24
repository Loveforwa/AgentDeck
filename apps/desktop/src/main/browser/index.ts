// 主进程的 browser 模块（线 5 · U1 U3）。职责：
// 1. 实现 contracts 的 BrowserService（prepare / fileUrl / openExternal / ping），注册到 IPC 注册表上。
// 2. 响应头改写：prepare 过的本地来源（localhost、127.0.0.1、[::1]……）作为 iframe 加载时，
//    去掉 X-Frame-Options 和 CSP 里的 frame-ancestors，否则 dev server 的页面嵌不进白板。其他网站不动。
// 3. agentdeck-file:// 协议：本地 HTML 文件通过它打开，只能读用户打开过的文件所在目录及子目录（防路径穿越、符号链接逃逸）。
// 4. 往白板里网页窗口的 iframe 注入小桥脚本（bridge.ts），让界面知道 iframe 里的地址、能后退前进。
// 5. 外部网站的 webview 模式（webview.ts，IS-44）：锁住白板页面挂的 webview，设置它的分区（UA、权限），
//    处理 webview 里的快捷键和登录弹窗。
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
// - 白板页面的 setWindowOpenHandler 一律 deny：iframe 里的 window.open 打不开。webview 里的弹窗由这里放行。
// - 应用窗口要开 webviewTag: true；挂上去的 webview 由这里的 will-attach-webview 锁住。
// agentdeck-file 协议注册成非 standard，不需要 registerSchemesAsPrivileged（Electron 45 实测）。

import { realpath, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { app, net, session as electronSession, shell, webContents, webFrameMain } from 'electron';
import type { Session, WebContents } from 'electron';
import { LOCAL_FILE_SCHEME } from '@agentdeck/contracts';
import type { ServiceRegistry } from '../registry.ts';
import { BRIDGE_SCRIPT, isBoardFrame } from './bridge.ts';
import { pingFetch } from './ping-fetch.ts';
import { ALLOWED_PERMISSIONS, WEB_PARTITION, browserUserAgent, guestShortcut, lockDownWebview, popupAllowed } from './webview.ts';
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
    setUpWebPartition(electronSession.fromPartition(WEB_PARTITION));
    for (const wc of webContents.getAllWebContents()) attachToWindow(wc);
    app.on('web-contents-created', (_event, wc) => attachToWindow(wc));
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

/** webview 分区：UA 不带 Electron 和应用名；只给剪贴板写入和全屏权限。 */
function setUpWebPartition(ses: Session): void {
  ses.setUserAgent(browserUserAgent(ses.getUserAgent(), app.getName()));
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}

/** 只管应用自己的窗口（白板页面），不管 webview 和别的 webContents。 */
function attachToWindow(wc: WebContents): void {
  if (wc.getType() !== 'window') return;

  wc.on('will-attach-webview', (event, webPreferences, params) => {
    if (!lockDownWebview(webPreferences, params)) event.preventDefault();
  });
  wc.on('did-attach-webview', (_event, guest) => attachGuest(guest));

  wc.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (frame === undefined || frame.isDestroyed()) return;
    const parentIsBoard = frame.parent?.frameTreeNodeId === wc.mainFrame.frameTreeNodeId;
    if (isBoardFrame({ name: frame.name, parentIsBoard })) frame.executeJavaScript(BRIDGE_SCRIPT).catch(() => {});
  });
}

/** 白板上的 webview：⌘[ ⌘] ⌘R 直接在这里处理；window.open 的 http(s) 地址开成弹窗（第三方登录），同一个分区。 */
function attachGuest(guest: WebContents): void {
  const isMac = process.platform === 'darwin';
  guest.on('before-input-event', (event, input) => {
    const key = guestShortcut(input, isMac);
    if (key === null) return;
    event.preventDefault();
    const history = guest.navigationHistory;
    if (key === 'back' && history.canGoBack()) history.goBack();
    else if (key === 'forward' && history.canGoForward()) history.goForward();
    else if (key === 'reload') guest.reload();
  });
  guest.setWindowOpenHandler(({ url }) =>
    popupAllowed(url)
      ? {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        }
      : { action: 'deny' },
  );
}
