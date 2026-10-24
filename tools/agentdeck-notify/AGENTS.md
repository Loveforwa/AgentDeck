# agentdeck-notify

agent 钩子运行的小命令（线 4，任务 S1）。用法：

```
agentdeck-notify <agent> <hookName> [payload]
```

- 从 stdin 读钩子负载（JSON；不是 JSON 就按字符串传）。第三个参数给旧版 codex 的 legacy notify 用（它把 JSON 放在最后一个参数里）。
- 从环境变量 `AGENTDECK_TERM` 读终端 id（tmux-host 给每个窗格设）。没有这个变量就什么也不做：用户在自己的终端里跑同一个 agent 时不会误报。
- 连 `~/.agentdeck/run/hooks.sock`（`AGENTDECK_HOOK_SOCKET` 可以覆盖，测试用），发一行 `HookEnvelope`（协议见 `packages/contracts/src/agent.ts`）。
- claude、codex 的 `PermissionRequest` 会等一行 `HookReply`，2 秒没回按 none。回 allow 时往 stdout 写
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`（两边格式相同）；none 什么也不写，agent 照常显示自己的确认。
- **绝不让 agent 卡住或报错**：连不上、超时、出错，都安静退出 0，不往 stdout / stderr 写东西。不等回答的钩子最多 1 秒。

谁写钩子配置：`packages/agent-adapters`（claude 用 `--settings`，codex 用 `-c hooks.…`），命令形如 `'<notify 绝对路径>' claude Stop`。
服务端：`packages/agent-adapters` 的 `HookServer`。

## pi / omp 的扩展（X13）

`bin/agentdeck-pi-extension.mjs`：pi、omp 启动时用 `-e` 加载的扩展（default export 工厂函数），在 agent 自己的进程里跑（pi 是 node，omp 是 bun）。
把扩展事件转成和 claude 同名的钩子，再运行 `$AGENTDECK_NOTIFY <agent> <钩子名>`（负载走 stdin），一条一条按顺序发，每条最多 3 秒。
没有 `AGENTDECK_TERM` 或 `AGENTDECK_NOTIFY` 时什么也不注册。事件对照表见 `packages/agent-adapters/AGENTS.md`「pi / omp 的扩展」。

## 文件

- `bin/agentdeck-notify.mjs`：纯 JS，只用 node 内置模块，不 import contracts（运行时没有 TypeScript）。常量和 contracts 保持一致，测试会核对。
  JSDoc 写类型，`tsc --checkJs` 检查。
- 以后可以换成编译好的单文件；打包时怎么跑见 `packages/agent-adapters/AGENTS.md`「agentdeck-notify 怎么打包」。

## 测试

```bash
pnpm --filter @agentdeck/agentdeck-notify test       # 起真的子进程，对着临时 socket
pnpm --filter @agentdeck/agentdeck-notify typecheck
```

`test/pi-extension.test.ts`：事件转换表、不在 AgentDeck 终端里不注册、处理函数不返回值、按顺序起 notify。端到端（扩展 → notify → HookServer → 状态机）在 `packages/agent-adapters/test/known-agents.test.ts`。

覆盖：发出的 envelope、默认 socket 路径、allow / none / 2 秒超时、没有服务端时快速退出 0、没有 AGENTDECK_TERM、legacy notify 参数、非 JSON 负载、常量和 contracts 一致。

## 不许碰

`packages/contracts`（协议要改先看它的 AGENTS.md）、其他包。
