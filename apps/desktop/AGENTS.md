# @agentdeck/desktop

Electron 应用外壳和 IPC 层（任务 F3）。按 `packages/contracts/src/ipc.ts` 的线路约定，把界面的 `window.agentdeck` 接到主进程里注册的服务上。第 3 波组装时，真实服务在这里注册。

## 结构

```
electron.vite.config.ts   main / preload / renderer 三份构建；contracts 打进产物，preload 输出 CJS（sandbox 要求）
src/main/
  index.ts          入口：建窗口、装 IPC、启动终端 utilityProcess、注册服务
  services.ts       唯一的注册表实例：registerService、emit
  registry.ts       注册表：按 { service, method } 路由，异常转 AgentDeckErrorData（纯逻辑，可单测）
  ipc.ts            ipcMain ↔ 注册表 / 终端端口（Electron 对象注入）
  events.ts         emit(event) 广播给所有窗口
  terminal-ports.ts 每个窗口一条 MessageChannelMain：port1 给 preload，port2 给 utilityProcess
  host-process.ts   启动终端 utilityProcess，转交端口和控制消息
  dev-services.ts   内联的最小假服务（app、terminals），只用来自检，组装时删除
src/utility/
  echo-host.ts      utilityProcess 里跑的回显假进程，以后换成 packages/tmux-host
src/preload/
  index.ts          contextBridge.exposeInMainWorld('agentdeck', ...)
  api.ts            通用代理（纯逻辑，可单测）
src/shared/
  methods.ts        每个服务的方法名单 + 穷尽检查（contracts 加方法时这里会类型报错）
  wire.ts           错误转换、消息校验、FIRE_AND_FORGET 判断
  host-protocol.ts  主进程 ↔ utilityProcess 的控制消息（不属于 contracts）
src/renderer/       React 18 页面。现在只有浅灰底和左下角的 IPC 自检
test/               Vitest：注册表、preload 代理、主进程接线
```

## 线路

- 调用：`api.git.status(repo)` → `ipcRenderer.invoke('agentdeck:invoke', { service, method, args })` → 注册表 → 结果或 `{ error }`；preload 把 `{ error }` 还原成 `AgentDeckError` 抛出。
- `FIRE_AND_FORGET` 里的方法（`terminals.write/resize`、`app.setBadge`）走 `ipcRenderer.send('agentdeck:send', ...)`，没有返回，出错只记日志。
- 事件：服务调 `emit(event)` → 所有窗口的 `agentdeck:event` → `api.on(type, listener)`。
- 终端输出：preload 启动时发 `agentdeck:terminal-port`，主进程建 MessageChannelMain，port1 发给该窗口，port2 连同窗口 id（webContents.id）交给 utilityProcess。utilityProcess 直接往端口写 `TerminalDataMessage`，界面用 `api.onTerminalData` 收。
- 只接受顶层 frame 的 IPC；子 frame 的调用返回 invalid-argument。

## 注册服务

```ts
import { emit, registerService, registry } from './services.ts';

registerService('git', gitService);          // 实现 contracts 里的 GitService；可以只实现部分方法
emit({ type: 'git.changed', repo });         // 推事件
registry.context()?.senderId;                // 在服务方法里取发起调用的窗口（webContents.id），异步链里也有效
```

- 服务抛 `AgentDeckError`（或 `AgentDeckErrorData` 形状的对象）会原样传到界面；其他异常变成 `internal`，`detail` 是堆栈。
- 没注册的服务或方法返回 `not-found`。同名重复注册会抛错。
- 现在 `src/main/index.ts` 里调用 `registerDevServices` 注册了内联假服务；接真实实现时去掉它，避免重复注册。

## 安全

`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；页面只能用 `window.agentdeck`。禁止页面跳转和 `window.open`。index.html 带 CSP。

## 运行

```bash
pnpm dev                                  # 根目录，等于 pnpm --filter @agentdeck/desktop dev
pnpm --filter @agentdeck/desktop test     # 单测
pnpm --filter @agentdeck/desktop typecheck
pnpm --filter @agentdeck/desktop build    # 产物在 out/
```

开发模式下界面的 console 会打到终端；窗口左下角四项自检（invoke、event、error、terminal port）都应是 `ok`，终端里会有对应的 `[ipc-check] ... ok` 行。

Electron 45 第一次运行时才下载二进制（pnpm 10 不跑依赖的 postinstall）。走代理时 `@electron/get` 不认 `https_proxy`，需要：

```bash
ELECTRON_GET_USE_PROXY=1 GLOBAL_AGENT_HTTPS_PROXY=$https_proxy node apps/desktop/node_modules/electron/install.js
```

## 不许碰

- `packages/contracts`：线路约定有问题写进 `CONTRACT_NOTES.md`。
- 其他包的目录。这里不 import `tools/fakes`、`packages/ui/*` 以外的界面包；组装前也不 import 服务包。
