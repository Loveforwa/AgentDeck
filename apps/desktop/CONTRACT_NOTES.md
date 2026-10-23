# 对 contracts 线路约定的意见（F3）

实现 `packages/contracts/src/ipc.ts` 时发现的问题。这里没有改 contracts，只记下来，由集成负责人决定。

## 1. 界面里 `instanceof AgentDeckError` 不成立

contextBridge 跨世界复制 Error 时只保留 message，`code`、`detail`、`name` 全丢（实测 Electron 45：界面收到的是 `Error`，`code` 为 undefined）。
所以 preload 改用 `contextBridge.executeInMainWorld` 在页面世界里构造 API，错误在页面世界里 new 出来，`name`、`code`、`detail`、`toData()` 都在。
但它是页面世界里另一个类，不是界面 bundle 里从 contracts import 的那个 `AgentDeckError`，所以：

- 可以：`isAgentDeckErrorData(err)`、`err.code === 'not-found'`、`err.name === 'AgentDeckError'`、`err instanceof Error`。
- 不行：`err instanceof AgentDeckError`（contracts 的类）。

建议在 contracts 的 `AgentDeckError` 上加 `static [Symbol.hasInstance]`（按 name + code 判断），或在注释里写明界面用 `isAgentDeckErrorData` 判断。这是只加不改的改动。

## 2. 成功结果和 `{ error }` 共用一个返回值

约定是“结果，或 `{ error: AgentDeckErrorData }`”。如果某个服务的正常返回值恰好是 `{ error: { code, message } }`，就会被当成失败。
现在两端都只把“只有 `error` 一个键、且形状是 AgentDeckErrorData”的对象当失败，contracts 里目前没有会撞上的返回类型。
建议以后改成明确的信封：`{ ok: true, value } | { ok: false, error }`（要动线路约定，影响只有 apps/desktop 两端）。

## 3. 方法名单只在类型里

contextBridge / executeInMainWorld 都只能复制对象上真实存在的键，不能暴露 JS Proxy，所以 preload 需要运行时的方法名单。
现在放在 `apps/desktop/src/shared/methods.ts`，带穷尽检查：contracts 加了方法而这里没加，`pnpm typecheck` 会报错，提醒同步。
如果别的包（例如 tools/fakes 做全量假实现、Playwright 用例）也需要这张表，可以考虑把它挪进 contracts，和 `FIRE_AND_FORGET` 放一起。

## 4. 终端输出端口按窗口分，view 要知道属于哪个窗口

约定里 utilityProcess “直接往这个端口写”，但有多个窗口（或页面刷新）时就有多个端口。现在的做法：

- 每个窗口（webContents.id）一条 MessageChannel；刷新时重新要端口，旧的被替换。
- 主进程把 `{ type: 'window-port', windowId }` 连同端口发给 utilityProcess（`src/shared/host-protocol.ts`）。
- `terminals.attach` 在主进程里执行时能用 `registry.context().senderId` 拿到窗口 id，tmux-host 据此把这个 view 的输出写到对应端口。

`TerminalHost.attach` 的签名里没有窗口信息，这是靠调用上下文补上的。线 1 实现 tmux-host 时需要知道这一点：主进程里的 terminals 服务是个转发层，要把 senderId 一起转给 utilityProcess。

## 5. 端口建好之前的终端输出

界面先 `attach` 再收到端口的情况理论上不会出现（preload 一启动就要端口，远早于第一次 attach），但约定里没写。现在端口到达之前的 `onTerminalData` 订阅会正常生效，只是端口没到之前不会有数据；utilityProcess 收到某窗口端口之前写给该窗口的数据会被丢掉。
