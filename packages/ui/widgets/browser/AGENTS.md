# @agentdeck/ui-widget-browser

白板上的网页窗口（线 5 · U1 U2 U3）。需求见设计画布「7 · 网页窗口」。主进程那一半在 `apps/desktop/src/main/browser/`（同一条线负责）。

## 职责

- 在白板上显示 dev server 页面或本地 HTML 文件。内容是 iframe，跟着白板的 `transform: scale()` 一起缩放。
- 工具栏：后退 ⌘[、前进 ⌘]、刷新 ⌘R、地址栏（单击或 ⌘L 编辑，↩ 打开，Esc 取消；只接受 http、https 和本地文件）、Open in browser。
- 打开、刷新、Retry 之前先 `browser.ping`：服务没起来显示 “… isn’t responding.” + Retry；文件不存在显示 “File not found” 和路径；页面拒绝被嵌入显示 “This page can’t be shown on the board.” + Open in browser。
- 标题栏状态：加载中 `Loading…`（muted、空心点），服务没响应 `Not responding`（error）；其他时候清掉。
- 没聚焦时内容区盖一层透明罩：第一次单击只 `requestFocus()`，不传给网页；滚轮交给白板。
- iframe 里自己跳转（点链接、pushState）时，地址栏跟上并把新地址写回 `data.url`（白板负责保存，重启后打开的是最后看的页面）。

## 对外接口

```ts
import { browserWindowType, BrowserWindow, browserReuseKey } from '@agentdeck/ui-widget-browser';

registerWindow(browserWindowType); // 组装时调用；registerWindow 由 packages/ui/canvas 的注册表提供（线 2）
```

| 导出 | 说明 |
| --- | --- |
| `browserWindowType` | `WindowTypeDefinition<BrowserWindowData, ComponentType<WindowComponentProps<BrowserWindowData>>>`：type `browser`，label `Browser`，默认 640×420，最小 320×200，没有摘要卡；`create({ url?, mode? })` |
| `BrowserWindow` | 组件，props 就是 contracts 的 `WindowComponentProps<BrowserWindowData>`；服务只用 `window.agentdeck.browser` |
| `browserReuseKey(url)` | 开网页窗口时的 `reuseKey`：http(s) 用 origin，本地文件用路径 |
| `normalizeAddress`、`displayAddress` | 地址栏的解析和显示（纯函数） |

### 和白板的约定（U2）

- 终端里点 localhost 链接：白板执行 `openWindow({ type: 'browser', data: { url, mode: 'frame' }, reuseKey: browserReuseKey(url) })`。
- 同一 origin 已经开着：白板聚焦那个窗口，并把 `data.url` 换成新地址 → 网页窗口跳过去。
- 地址相同时要“刷新”：在 data 里带一个新的 `reloadToken`（例如 `Date.now()`）→ 网页窗口刷新。`reloadToken` 还不在 contracts 里，见 `CONTRACT_NOTES.md` 第 1 条；网页窗口已经支持。
- 网页窗口自己写回的 `data.url` 不会触发重新加载（记着自己写过哪些、按顺序对掉）。

## 和主进程的配合

- `browser.prepare(url)`：localhost 来源加进响应头改写名单；本地文件换成 `agentdeck-file:///…`。iframe 的 `src` 只用它返回的地址。
- iframe 的 `name` 是 `agentdeck-browser:<windowId>`。主进程只往这种 iframe 里注入小桥脚本（`apps/desktop/src/main/browser/bridge.ts`），小桥用 postMessage 报地址、能不能后退前进、页面里按的 ⌘ 快捷键；网页窗口用 postMessage 让它后退、前进、刷新。消息格式在 `src/bridge.ts`，两边要同步改。
- 没有小桥时（普通浏览器里跑 dev 页面、注入失败）也能用：后退前进只走网页窗口自己打开过的地址，刷新靠重建 iframe，地址栏跟不上 iframe 里的跳转。
- 小桥报上来的地址只认 http(s)；本地文件地址只在本来就开着本地文件时才认，防止网页把本地路径塞进 `data.url`。
- iframe 的 sandbox 不给 `allow-top-navigation`：嵌进来的页面不能把白板页面跳走。

## 风险 3 的结论：需要登录的网页

试验：`apps/desktop/src/main/browser/trial/risk3.ts`（Electron 45 / Chromium 156，2026-10-23）。登录页用 `SameSite=Lax`、`HttpOnly` 的 cookie，同时带 `X-Frame-Options: DENY` 和 `frame-ancestors 'none'`（来自 `dev/login-app.ts`）。

| 白板页面 | 嵌入方式 | 能显示 | 登录 | fetch 带 cookie | 刷新后还在 | 页面用 JS 写的 cookie |
| --- | --- | --- | --- | --- | --- | --- |
| file://（打包后） | iframe，只去 X-Frame-Options | ✓ | ✗ cookie 根本没存 | ✗ | ✗ | ✗ |
| file:// | **iframe + Set-Cookie 改成 `SameSite=None; Secure`（现在的做法）** | ✓ | ✓ | ✓ | ✓ | ✗ |
| file:// | `<webview>`，独立 partition | ✓ | ✓ | ✓ | ✓ | ✓ |
| http://localhost（electron-vite dev） | iframe，只去 X-Frame-Options | ✓ | ✓ | ✓ | ✓ | ✓ |
| http://localhost | iframe + 改 cookie | ✓ | ✓ | ✓ | ✓ | ✓ |
| http://localhost | `<webview>` | ✓ | ✓ | ✓ | ✓ | ✓ |

127.0.0.1 和 [::1] 的登录页在 file:// 白板里 + 改 cookie 的结果和 localhost 一样（Chromium 允许这三个 http 地址设 `Secure` cookie）。另外截图确认 `<webview>` 放在 `transform: scale(0.5)` 里也跟着缩放，和 iframe 一样。

结论：

1. **风险是真的，而且开发时看不出来。** electron-vite dev 下白板页面是 `http://localhost:5173`，和 dev server 同站，Lax cookie 照常；打包后白板页面是 `file://`，iframe 里的 localhost 算跨站，Lax（以及没写 SameSite、默认按 Lax 的）cookie 存不进，登录态全丢。
2. **MVP 已经补上大部分：** 主进程对改写名单里的本地来源，把所有响应的 `Set-Cookie` 改成 `SameSite=None; Secure`（`headers.ts` 的 `relaxSetCookies`）。服务端设 cookie 的登录（绝大多数 session 登录）在 iframe 里能用。影响只在 AgentDeck 自己的 session 里，不改用户的服务。
3. **还不行的：** 页面自己用 `document.cookie` 写的 Lax cookie；跳到第三方登录页（GitHub、Google 的 OAuth 页面本身拒绝被嵌入，而且不在改写名单里）；`window.open` 弹出的登录窗口（应用禁止开新窗口）。这些 MVP 里用 Open in browser。
4. **P1（X11）用 `<webview>`：** 窗口菜单里加 “Open as separate window”（或出错页上的按钮），把 `data.mode` 改成 `'webview'`，同一个窗口改用 `<webview partition="persist:agentdeck-web">` 显示。webview 是真正的顶层页面，上面三种情况都能登录，而且实测能跟着白板缩放，所以不需要开系统窗口。代价：应用窗口要开 `webviewTag: true`（并在 `will-attach-webview` 里锁住 preload 和 webPreferences），每个 webview 是单独的 webContents，后退前进用 webview 自己的 API，不走小桥。

## 跑起来

```bash
pnpm --filter @agentdeck/ui-widget-browser dev     # dev 页面 http://localhost:5330，连带 5331 / 5332 两个本地登录服务
pnpm --filter @agentdeck/ui-widget-browser test
pnpm --filter @agentdeck/ui-widget-browser typecheck
```

dev 页面用一个简单的容器代替白板，按 `WindowComponentProps` 传 props，服务是 `createFakeApi()`：左边可以模拟“从终端打开”（同 origin 复用并刷新）、开本地文件、缩放白板、让 5332 的 ping 失败；底部列出 `updateData` / `setStatus` 调用。5331 带 X-Frame-Options，在普通浏览器里会被拒（假服务不改写响应头），这是预期的。

在 Electron 里用真的主进程模块跑同一个 dev 页面（自动点一遍并截图）：

```bash
apps/desktop/node_modules/.bin/electron apps/desktop/src/main/browser/trial/widget.ts          # SHOW=1 显示窗口、跑完不退出
apps/desktop/node_modules/.bin/electron apps/desktop/src/main/browser/trial/risk3.ts           # 风险 3 试验
```

## 测试

- `test/pure.test.ts`：地址栏解析和显示、reuseKey、小桥消息校验、没有小桥时的历史、`browserWindowType`。
- `test/browser-window.test.tsx`（jsdom + Testing Library + `createFakeApi`）：打开和加载状态、出错页和 Retry、File not found、Chromium 出错页的两种情况、地址栏编辑 / 拒绝 / Esc / ⌘L、白板改 `data.url` 和 `reloadToken`、自己写回的地址不重载、小桥消息（跳转、后退、刷新、快捷键、伪造的地址、别的窗口的消息）、聚焦罩、Open in browser。
- 主进程部分的测试在 `apps/desktop/test/browser/`。

## 不许碰

只改本目录和 `apps/desktop/src/main/browser/`（测试在 `apps/desktop/test/browser/`）。不改 `packages/contracts`（意见写进 `CONTRACT_NOTES.md`）、不 import canvas 的内部文件、不 import 别的 widget。样式只用 design-tokens 的变量和 ui-kit 的零件，不写颜色值；界面文字英文。
