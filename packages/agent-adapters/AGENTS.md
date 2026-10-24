# @agentdeck/agent-adapters

线 4（Agent 和状态），任务 T4 S1 S2 S4。只在**主进程**里用。

- **适配器**（T4）：claude、codex、Shell、自定义命令，实现 contracts 的 `AgentAdapter`。检测安装、算启动命令、解析钩子。
- **已知 agent 表**（X13）：`src/adapters/known.ts` 登记 pi、omp、kimi（id、label、命令名、启动参数模板、扩展、能力），由通用适配器 `KnownAgentAdapter`（`generic.ts`）读。加 agent 只加一行，参数要先用真程序核对。
- **AgentService**（T4）：`list` / `refresh` / `start`。start 用适配器算 LaunchSpec，再调注入的 `TerminalHost.create`。
- **钩子 socket 服务端**（S1）：`HookServer`，收 `agentdeck-notify` 发来的 HookEnvelope，交给适配器的 `parseHook`。
  小命令本身在 `tools/agentdeck-notify`。
- **状态机**（S2）：`StatusMachine` 实现 `StatusService`，发 `status.changed`、`agent.turn-end`。`ApprovalServicePlaceholder` 是 P1 的占位。
- **后台通知规则**（S4）：`backgroundAlerts()` / `badgeCount()`，纯函数；真正发通知、设角标在 apps/desktop。

不许碰：`packages/contracts`（不够用写进本目录的 `CONTRACT_NOTES.md`）、`apps/desktop`、其他包。
本包不读环境、不写死路径：登录 shell 的环境、notify 的路径、socket 路径、破坏性名单都由构造参数传入。

## 组装（apps/desktop 主进程）

```ts
import { createAgentRuntime, backgroundAlerts } from '@agentdeck/agent-adapters';

const rt = createAgentRuntime({
  env: () => loginShellEnv,                       // docs/decisions.md：$SHELL -ilc env 读一次
  terminals: tmuxHost,                            // 只用 create
  notifyCommand: '/…/agentdeck-notify',           // 绝对路径，见下面「agentdeck-notify 怎么打包」
  agentExtension: '/…/agentdeck-pi-extension.mjs', // pi、omp 用 -e 加载；不给时它们没有钩子
  emit: (e) => sendToRenderer(e),                 // status.changed、agent.turn-end
  destructivePatterns: () => settings.approvals.destructivePatterns,
  extraArgs: (agent) => settings.agents[agent]?.extraArgs ?? [],
  mcp: () => mcpServer.endpoint,                  // M1：AgentDeck 的 MCP 服务（packages/mcp-server），没起来返回 null
});
await rt.start();                                 // 监听 ~/.agentdeck/run/hooks.sock
tmuxHostEvents.on((e) => rt.onTerminalEvent(e));  // terminal.activity / silence / exit / host-lost
// IPC 层：terminals.write、terminals.sendKeys 之后调 rt.noteInput(terminalId)（见状态表第 15 行）
// 挂到 IPC：agents → rt.agents，status → rt.status，approvals → rt.approvals
// 重开应用时，对上已有的终端：rt.status.track(id, { agent, workspaceId, hooks, status: 'idle', sessionId })
// 退出前：await rt.close()
```

后台通知：每次 `status.changed` 时调 `backgroundAlerts({ prev, next, all, appFocused, notificationsEnabled, label })`，
有 `notification` 就 `new Notification({ title, body })`，单击时发 `app.focus-terminal`；`badge` 交给 `app.setBadge`。

## 对外接口

| 导出 | 说明 |
| --- | --- |
| `createAgentRuntime(opts)` | 把下面几块接好：`agents`、`status`、`approvals`、`hookServer`、`onTerminalEvent`、`noteInput`、`start`、`close` |
| `AgentServiceImpl` | `AgentService`。`onStarted` 回调告诉状态机这次启动是否真的带上了钩子 |
| `createDefaultAdapters({ env, agentExtension? })` | `[ClaudeAdapter, CodexAdapter, …已知表里的每一行（KnownAgentAdapter）, ShellAdapter, CustomCommandAdapter]` |
| `KNOWN_AGENTS` / `KnownAgentAdapter` / `EXTENSION_ENV` | 已知 agent 表、通用适配器、扩展读的环境变量名 |
| `AgentAdapterExt` | `AgentAdapter` + 可选的 `prepare(ctx)`（launch 前的异步准备，codex 用） |
| `HookServer` | `start()` / `close()`；`decide` 回调决定 PermissionRequest 回 allow 还是 none（P0 一律 none） |
| `StatusMachine` | `StatusService` + `track` / `forget` / `onHook` / `onTerminalEvent` / `noteInput` / `get` / `pendingRequests` |
| `ApprovalServicePlaceholder` | P1 之前的占位：approve 返回 unsupported，setAutoApprove 抛 unsupported |
| `backgroundAlerts` / `badgeCount` | S4 规则 |
| `DEFAULT_DESTRUCTIVE_PATTERNS` | 建议的 Settings 默认值（rm -rf、git push --force、reset --hard、DROP/TRUNCATE、FLUSHDB/ALL、.env） |

## 各 agent 怎么启动

| agent | 新建 | resume | fork | 钩子 | “允许一次” |
| --- | --- | --- | --- | --- | --- |
| claude | `claude --session-id <新 uuid> --settings <json>` | `--resume <id>` | `--resume <id> --fork-session --session-id <新 uuid>` | `--settings` 里的 hooks | `Enter` |
| codex | `codex -c hooks.…（7 条）-c hooks.state={…}` | `codex resume <id> …` | `codex fork <id> …` | `-c` 覆盖 + 信任哈希 | `y` |
| shell | `$SHELL -l`；带命令时 `$SHELL -l -c <命令>` | 不支持 | 不支持 | 无 | 无 |
| custom | 按 shell 规则拆开的命令 | 不支持 | 不支持 | 无 | 无 |
| pi | `pi --session-id <新 uuid>` | `--session <id>` | `--fork <id> --session-id <新 uuid>` | `-e agentdeck-pi-extension.mjs`（0.80.4 起） | 无（pi 没有批准确认框） |
| omp | `omp`（会话 id 等扩展报） | `--resume <id>` | `--fork <id>`（新 id 等扩展报） | `-e agentdeck-pi-extension.mjs`（18.0 起，更早没验证） | 无（Approve / Deny 选择列表，按键没核对） |
| kimi | `kimi` | `-S <id>` | 不支持 | 无 | 无 |

- 用户在 Settings 里加的启动参数放在最后。claude 的 LaunchSpec.env 带 `CLAUDE_CODE_TMUX_TRUECOLOR=1`。
- `--settings` 的值是一整段 JSON，**线 1 的 tmux-host 建会话时要按参数数组传**（`new-session … -- cmd arg1 arg2`），不要拼成一行 shell 命令，否则要自己转义。
- 检测：在传入环境的 PATH 里找命令，跑 `--version` 取 x.y.z。版本取不到时按“够新”处理。
- claude 的钩子要 2.0 以上（粗略下限），StopFailure 事件只在 2.1 以上加；codex 的钩子要 0.159 以上（本机实测的版本，更早的没验证）。
- “允许一次”的按键是看确认框得出的（claude “❯ 1. Yes” 默认选中；codex “1. Yes, proceed (y)”），**待线 1 用真终端核对 send-keys 的效果**。

## 钩子实测（2026-10-23，claude 2.1.291，codex 0.159.2，macOS）

### claude：`--settings` 里的 hooks 是**合并**，不是替换

- 临时项目里放 `.claude/settings.json`（UserPromptSubmit、Stop 各一条），再用 `--settings` 加同名事件的钩子，`claude -p "reply with OK"`：**两边都运行了**。
- 用户级：临时 `CLAUDE_CONFIG_DIR` 里的 `settings.json` 加 UserPromptSubmit，再用 `--settings` 加同名事件：**两边都运行了**。
- 结论：AgentDeck 的钩子和用户、项目自己的钩子并存，不需要额外处理，也没改任何配置文件。
  例外：用户或管理员设置了 `disableAllHooks`（或托管策略只允许托管钩子）时我们的钩子也不会跑，这时状态退回到只靠输出活动（目前不会自动发现，见 CONTRACT_NOTES.md）。
- 每个钩子都是同步的命令钩子（PostToolUse 也是：保证它比同一轮的 Stop 先到），PermissionRequest 超时 5 秒，其他 3 秒。

### claude：各事件什么时候来

- 启动：`SessionStart`（`session_id` 就是我们传的 `--session-id`，`source: startup`）。
- 用户发消息：`UserPromptSubmit`。
- 要批准：`PreToolUse` → `PermissionRequest`（`tool_name`、`tool_input.command`）→ `Notification`（`notification_type: permission_prompt`）。
  批准后工具跑完有 `PostToolUse`，一轮结束 `Stop`。
- **拒绝（Esc 或选 “No”）后没有任何钩子**，也等不到 `idle_prompt` 通知（等了 110 秒）。屏幕显示 “Interrupted · What should Claude do instead?”。
  所以状态机用“用户输入过 + 之后 3 秒没输出 + 期间没有钩子”兜底回到 idle（状态表第 15 行），这要组装时调 `noteInput`。
  运行中按 Esc 打断同样没有 Stop，也走这条兜底。
- **AskUserQuestion 是以 `PermissionRequest`（`tool_name: AskUserQuestion`）来的**，不是单独的事件。适配器把它（还有 ExitPlanMode）转成 `question`，
  所以永远不会被当成批准、不会被 Approve all / Auto-approve 选中。回答后 `PostToolUse`（`tool_name: AskUserQuestion`）、`Stop`。
- claude 会并行跑工具：一个 Read 的 PostToolUse 可能在 Bash 还在等批准时到。状态机只在跑完的工具和等批准的是同一个（summary 相同）时才离开 needs-approval（第 8b 行）。

### codex：能注入，不改 ~/.codex/config.toml

- `-c hooks.<事件>=[{hooks=[{type="command",command="…",timeout=N}]}]` 能加钩子（session flags 层），但 codex **只运行信任过的钩子**：
  每条钩子有一个哈希（`sha256:…`），信任记录在用户配置的 `hooks.state` 里。不信任时 TUI 不运行它们（`codex exec` 里实测完全不触发）。
- 不用 `--dangerously-bypass-hook-trust`：它会让项目里没审过的钩子也运行。
- 做法：启动前起一次 `codex app-server`（stdio JSON-RPC），带上同样的 `-c` 调 `hooks/list`，拿到我们这几条钩子的 `key`（形如 `/<session-flags>/config.toml:stop:0:0`）和 `currentHash`，
  启动时再加 `-c 'hooks.state={"<key>"={trusted_hash="<hash>"},…}'`。codex 读 hooks.state 时 user 层和 session flags 层按字段合并（源码 `hooks/src/config_rules.rs`），用户自己的记录不受影响。
  哈希只和钩子配置有关，同一个 notify 路径只问一次（`CodexAdapter` 里缓存）。key 必须写成整张内联表：点号路径会被 key 里的 “.toml” 拆开。
- 带 `-c` 启动时 codex 不用共享后台服务（“requires embedded mode”的 Startup 警告），不影响使用。
- 事件：`SessionStart` **要等第一次输入才来**（不是一启动就来），会话 id 在 `session_id`；`UserPromptSubmit`；`PermissionRequest`（格式和 claude 一样）；
  `PostToolUse`；`Stop`；**拒绝批准（Esc）时有 `Interrupt`**，适配器转成 turn-end。回答 PermissionRequest 的输出格式和 claude 相同（`hookSpecificOutput.decision.behavior`）。
- 准备失败（app-server 不通、超时 10 秒、没列出我们的钩子）：这次启动不加钩子，`onStarted` 报 `hooks: false`，状态按输出活动判断。
- 0.159 之前的版本：用 legacy `-c notify=[notify路径,"codex","notify"]`，只知道一轮结束；**会顶掉用户自己的 notify 设置**。

## pi / omp 的扩展（X13）

pi、omp 没有命令式钩子，但有扩展事件。`tools/agentdeck-notify/bin/agentdeck-pi-extension.mjs` 启动时用 `-e` 临时加载（不写进 `~/.pi`、`~/.omp`），
LaunchSpec.env 带 `AGENTDECK_NOTIFY`（notify 路径）、`AGENTDECK_AGENT`（id）、`AGENTDECK_TURN_END`（pi `agent_settled`，omp `agent_end`）。
扩展把事件转成和 claude 同名的钩子，再运行 agentdeck-notify，所以 `KnownAgentAdapter.parseHook` 基本就是 `parseCommonHook`：

| 扩展事件 | 钩子 | 状态 |
| --- | --- | --- |
| session_start / session_switch / session_branch | SessionStart（`ctx.sessionManager.getSessionId()`） | idle，记下会话 id（omp 的新会话靠它） |
| agent_start | UserPromptSubmit | running |
| tool_call，工具是 ask（omp） | Question | needs-reply |
| tool_result，工具是 ask | UserPromptSubmit | running |
| tool_approval_requested（omp；参数从之前的 tool_call 记下） | PermissionRequest | needs-approval |
| tool_approval_resolved（omp） | UserPromptSubmit | running |
| agent_settled（pi）/ agent_end 且 willContinue 不为 true（omp） | Stop | idle，发 agent.turn-end |
| session_shutdown | SessionEnd | 不变 |

实测（2026-10-24，pi 0.83.0、omp 18.0.4）：临时 HOME、本地假的 OpenAI 兼容服务（不用账号、不花钱），`--mode rpc`（omp 的提问要 `--mode rpc-ui`）。
pi：SessionStart（就是 `--session-id` 给的 id）→ UserPromptSubmit → Stop → SessionEnd；`--session <id>` 接回、`--fork <id> --session-id <新>` 都报对了 id。
omp：`--approval-mode always-ask` 跑 bash，PermissionRequest 带上了 `command`，批准后 UserPromptSubmit、Stop；ask 工具 → Question（问题文字）→ 回答后 UserPromptSubmit → Stop；
`--resume <id>` 报原 id，`--fork <id>` 报新 id。没在真 TUI 里核对：omp 确认框“允许一次”的按键（所以没有 Approve all）。
真窗口（单独的 AgentDeck 实例、临时 HOME、同一个假模型）：菜单列出 Pi、Oh My Pi；pi 一轮 running → idle → turn-end；omp 的 bash 批准显示 needs-approval（summary 是命令），
在确认框按 Enter 批准后 running → idle → turn-end；omp 新会话的 id 由 SessionStart 报上来存进库，`--resume <id>` 能接回（omp 只在第一条消息后才写会话文件，没说过话的会话接不回）。

## AgentDeck 的 MCP（M1）

`LaunchContext.mcp` 有值时 claude 适配器加 `--mcp-config <json>`：一个叫 `agentdeck` 的 http 服务，
`Authorization: Bearer ${AGENTDECK_MCP_TOKEN}`、`x-agentdeck-terminal: ${AGENTDECK_TERM}`，由 claude 从环境里展开（2.1.291 实测），
token 本身只放进 `LaunchSpec.env`，不进命令行。和用户自己配的 MCP 合并（不用 `--strict-mcp-config`）。codex 暂时不挂。

`StartAgentRequest.prompt`（第一条消息）：claude、codex 都放在参数最后、`--` 之后（`--mcp-config` 和不少用户参数后面能跟多个值，不隔开会被吃掉）。只在新会话时带。

## agentdeck-notify 怎么打包（组装阶段）

现在是 `tools/agentdeck-notify/bin/agentdeck-notify.mjs`，开头 `#!/usr/bin/env node`，要求 tmux 会话的 PATH 里有 node。
pi 扩展 `agentdeck-pi-extension.mjs` 也要一起放进 Resources（它在 agent 自己的进程里跑，不需要 node）。
用户机器上不一定有 node，打包时二选一：放一个 sh 包装脚本 `exec env ELECTRON_RUN_AS_NODE=1 "<AgentDeck 可执行文件>" "<…>/agentdeck-notify.mjs" "$@"`，
或者编译成单文件可执行程序。`notifyCommand` 传这个包装脚本的绝对路径；路径里有空格没关系（钩子命令里会加引号）。

## 状态机

转换表写在 `src/status/machine.ts` 开头，`test/status-machine.test.ts` 每一行都有用例（编号对应）。要点：

- 有钩子的 agent：钩子说了算，输出活动只用来离开 starting、以及启动画面画完后变 idle。
- needs-reply 只在 agent 用提问工具时进入；一轮说完（Stop）是 idle。
- 没有钩子的程序：有输出 running，3 秒没输出 idle，不发 agent.turn-end（免得 dev server 每停一下就刷新面板）。
- 退出码 0 是 exited，非 0 是 error；tmux 没了（host-lost）全部 error。
- 破坏性：有命令看命令，没有命令（Edit 这类）看 summary（“Edit /repo/.env”）。名单每次判断时现取，改设置立即生效。
- 还没 track 就到的钩子留 10 秒，track 时补上（SessionStart 可能比 `TerminalHost.create` 返回还早）。
- `StatusSnapshot.sessionId` 带着当前会话 id；session-start 换了 id 时即使状态不变也发一次 status.changed（codex、omp 启动时不知道 id，靠它存进库和窗口数据）。

## 测试

```bash
pnpm --filter @agentdeck/agent-adapters test        # 单元测试 + 钩子 socket 端到端（起真的 agentdeck-notify 子进程）
pnpm --filter @agentdeck/agent-adapters typecheck
# 用真的 claude / codex 跑整条链（默认跳过；要 tmux、claude、codex 并已登录；只问问题，权限请求会被拒绝）：
AGENTDECK_REAL_AGENTS=1 pnpm --filter @agentdeck/agent-adapters exec vitest run real-agents
```

- `test/fixtures.ts` 是实测抓到的钩子负载。agent 升级后先跑一次 real-agents，钩子格式变了就更新 fixtures 和解析。
- 终端用 `tools/fakes` 的 `FakeTerminalHost`；real-agents 里用一个只有 create 的 tmux 小实现（`tmux -L agentdeck-l4-real -f /dev/null`）。
