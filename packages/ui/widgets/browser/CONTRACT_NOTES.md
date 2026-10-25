# 对 contracts 的意见（线 5 · 网页窗口）

> **已处理（2026-10-23，contracts 0.1.3，提交 68024ca）**：第 1、2 条加进 `BrowserWindowData`（`reloadToken`、`openedBy`），复用时浅合并 data 写进了 `OpenWindowRequest` 注释；第 3 条选了 `titleBar: 'none'` + `data-window-drag` + `toggleMaximize()`；第 4 条加了 `TerminalHost.recentLinks`（线 1 实现）；第 5 条加了 `prepare(url, { mode })`；第 6、7 条写进了注释。网页窗口去掉本地的 `DataWithToken`、改成自己画标题栏待线 5 跟进（白板支持 `titleBar: 'none'` 待线 2）。

做 U1 U2 U3 时发现 contracts 0.1.2 不够用或没说清楚的地方。这里没有改 contracts，由集成负责人决定。前 3 条影响别的线。

## 1. 同一地址已经开着时“聚焦并刷新”表达不出来（U2，影响线 2）

`OpenWindowRequest.reuseKey` 只说了“聚焦它而不是新开”，没说复用时 `data` 怎么办，也没有“刷新”的信号。

- 地址不同（同 origin 的另一个页面）：建议约定复用时白板把 `req.data` 合并进已开窗口的 data。网页窗口看到 `data.url` 变了就跳过去（已实现）。
- 地址相同：data 不变，网页窗口不知道要刷新。建议给 `BrowserWindowData` 加可选字段（只加不改）：

  ```ts
  /** 白板复用窗口时换一个新值（例如 Date.now()），网页窗口据此刷新。 */
  reloadToken?: number;
  ```

  网页窗口已经按这个字段实现（`src/BrowserWindow.tsx` 的 `DataWithToken`），contracts 加上后去掉本地类型即可。

## 2. 网页窗口不知道“哪个终端打开的它”

设计画布结构图第 3 项要在工具栏显示来源（如 “from zsh · pnpm dev”），`BrowserWindowData` 里没有。建议加可选字段：

```ts
openedBy?: { terminalId: TerminalId; label: string } | null;
```

白板在处理 `terminal.link` 时填（线 2），网页窗口显示（线 5）。现在工具栏没有这一项。

## 3. 网页窗口的标题栏和工具栏是一行，但 contracts 让白板画标题栏（影响线 2）

设计里网页窗口只有一行：后退前进刷新、地址栏、来源、Open in browser、放大、关闭，拖工具栏空白处移动窗口。
`WindowComponentProps.contentSize` 写的是“不含标题栏”，即白板统一画标题栏，所以现在网页窗口是“白板标题栏 + 自己的工具栏”两行。建议二选一：

- `WindowTypeDefinition` 加 `titleBar?: 'board' | 'none'`；`'none'` 时窗口自己画，并约定拖动区域（例如元素上加 `data-window-drag`）、放大和关闭用 props 里的方法（要再加一个 `toggleMaximize()`）。
- 或者 `WindowComponentProps` 加一个往白板标题栏里放内容的口子（`setTitleBarContent(node)`），contracts 不依赖 React，类型要用泛型。

## 4. “New browser” 的起始页拿不到终端里出现过的地址

需求：“起始页列出这个工作区的终端里出现过的本地地址，单击打开”。现在只有实时的 `terminal.link` 事件，窗口打开之前出现的地址拿不到。建议线 1 / 线 4 在服务端记下每个终端最近的链接，例如 `TerminalHost.recentLinks(id): Promise<TerminalLink[]>`，或者按工作区查。现在空的网页窗口只显示一句提示。

## 5. `prepare` 只看地址，P1 的 webview 模式要多一个参数

`prepare(url)` 返回的 `mode` 现在总是 `'frame'`。P1 切到 webview 时主进程要做的事不同（不改响应头、用独立 partition）。建议 P1 时加可选参数 `prepare(url, { mode?: 'frame' | 'webview' })`，或者约定 mode 只由 `BrowserWindowData.mode` 决定、`PreparedPage.mode` 原样返回。另外 webview 要在应用窗口开 `webviewTag`，属于组装（apps/desktop）。

## 6. 写清楚 `ping` 的含义

现在的实现：http(s) 只要服务回了任何 HTTP 响应（包括 404、500）就是 `ok: true`，连不上或 3 秒没响应是 `{ ok: false, status: null }`；本地文件存在是 `{ ok: true, status: 200 }`，不存在是 `{ ok: false, status: 404 }`。界面据此区分 “isn’t responding” 和 “File not found”。建议把这段写进 `browser.ts` 的注释，假实现（tools/fakes）的默认值已经一致。

## 7. 本地文件在 `data.url` 里存什么

现在存绝对路径（`/Users/me/report.html`），不存 `agentdeck-file://` 地址；网页窗口打开时再 `prepare`，主进程借此把文件所在目录加进可读名单（重启后也一样）。终端里的 `TerminalLink { kind: 'file', path }` 打开 .html 时，白板直接把 `path` 放进 `data.url`、`reuseKey` 用路径即可。建议在 `BrowserWindowData.url` 的注释里写明“http(s) 地址或本地文件的绝对路径”。

## 不需要进 contracts 的约定（记一下）

- iframe 和主进程注入的小桥之间的 postMessage 格式（`src/bridge.ts` ⇄ `apps/desktop/src/main/browser/bridge.ts`）不经过 IPC，放在线 5 自己的两个目录里。
- iframe 的 `name` 前缀 `agentdeck-browser:` 同上。
