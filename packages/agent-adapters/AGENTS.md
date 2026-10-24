# @agentdeck/agent-adapters

线 4（Agent 和状态），任务 T4 S1 S2 S4。只在**主进程**里用。

- **适配器**（T4）：claude、codex、Shell、自定义命令，实现 contracts 的 `AgentAdapter`。检测安装、算启动命令、解析钩子。
- **已知 agent 表**（X13）：`src/adapters/known.ts` 登记 pi、omp、kimi（id、label、命令名、启动参数模板、扩展、能力），由通用适配器 `KnownAgentAdapter`（`generic.ts`）读。加 agent 只加一行，参数要先用真程序核对。
- **AgentService**（T4）：`list` / `refresh` / `start`。start 用适配器算 LaunchSpec，再调注入的 `TerminalHost.create`。
- **钩子 socket 服务端**（S1）：`HookServer`，收 `agentdeck-notify` 发来的 HookEnvelope，交给适配器的 `parseHook`。
  小命令本身在 `tools/agentdeck-notify`。
- **状态机**（S2）：`StatusMachine` 实现 `StatusService`，发 `status.changed`、`agent.turn-end`。
- **批准**（PL1 Auto-approve、X3 Approve all）：`ApprovalServiceImpl` 实现 `ApprovalService`，见下面「Auto-approve 和 Approve all」。
- **后台通知规则**（S4）：`backgroundAlerts()` / `badgeCount()`，纯函数；真正发通知、设角标在 apps/desktop。
- **token 用量**（PL2 · Usage 插件，DR-55）：`src/usage/`，`UsageServiceImpl` 实现 contracts 的 `UsageService`，读各 agent 自己的会话文件。见下面「token 用量」。
- **Skills · MCP**（MVP v3 · N9）：`src/skills/`，`SkillsServiceImpl` 实现 contracts 的 `SkillsService`（库、仓库里的 skill、每种 agent 怎么带），启动前算出这次带什么交给适配器。见下面「Skills · MCP」。

不许碰：`packages/contracts`（不够用写进本目录的 `CONTRACT_NOTES.md`）、`apps/desktop`、其他包。
本包不读环境、不写死路径：登录 shell 的环境、notify 的路径、socket 路径、破坏性名单都由构造参数传入。

## 组装（apps/desktop 主进程）

```ts
import { createAgentRuntime, backgroundAlerts } from '@agentdeck/agent-adapters';

const rt = createAgentRuntime({
  env: () => loginShellEnv,                       // docs/decisions.md：$SHELL -ilc env 读一次
  terminals: tmuxHost,                            // create；批准用 sendKeys、lastLines
  approvalRecords: store.approvals,               // 批准记录写进库（不给只在内存里）
  notifyCommand: '/…/agentdeck-notify',           // 绝对路径，见下面「agentdeck-notify 怎么打包」
  agentExtension: '/…/agentdeck-pi-extension.mjs', // pi、omp 用 -e 加载；不给时它们没有钩子
  emit: (e) => sendToRenderer(e),                 // status.changed、agent.turn-end
  destructivePatterns: () => settings.approvals.destructivePatterns,
  extraArgs: (agent) => settings.agents[agent]?.extraArgs ?? [],
  mcp: () => mcpServer.endpoint,                  // M1：AgentDeck 的 MCP 服务（packages/mcp-server），没起来返回 null
  mcpPluginDir: '/…/mcp-plugin',                  // N1：写好 mcpPluginFiles() 的目录，omp 用 --plugin-dir 加载；不给时 omp 不挂
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
| `codexMcpOverrides` / `mcpPluginFiles` / `MCP_URL_ENV` | N1：codex 挂 MCP 的 `-c` 参数；omp 的插件目录内容（相对路径 → 文本）和清单里 url 读的环境变量 |
| `AgentAdapterExt` | `AgentAdapter` + 可选的 `prepare(ctx)`（launch 前的异步准备，codex 用） |
| `HookServer` | `start()` / `close()`；`decide` 回调决定 PermissionRequest 回 allow 还是 none（runtime 接 `ApprovalServiceImpl.decide`），先回答再 `onHook`，`ReceivedHook.decision` 是送到了的回答 |
| `StatusMachine` | `StatusService` + `track` / `forget` / `onHook` / `onTerminalEvent` / `noteInput` / `get` / `pendingRequests` |
| `ApprovalServiceImpl` | `ApprovalService`，外加 `decide` / `noteAutoAllowed` / `onStatusEvent`（runtime 接线用）、`isOn(terminalId)` |
| `autoApproveSupport` / `approvalStrategy` | 每种 agent 的做法（`src/status/support.ts`） |
| `matchOmpApproval` | omp 的 Approve / Deny 确认框认屏规则（`src/status/screens.ts`） |
| `backgroundAlerts` / `badgeCount` | S4 规则 |
| `UsageServiceImpl` / `defaultUsageRoots` / `USAGE_HOOK` | token 用量（见「token 用量」）；各 agent 的读取器 `ClaudeUsageParser` 等也导出 |
| `SkillsServiceImpl` / `SkillLibrary` / `skillsSupport` / `builtinSkillFiles` / `scanRepoSkills` | N9，见「Skills · MCP」；`codexLibraryMcpOverrides`、`claudeMcpConfig(mcp, library)` 是库里 MCP 的启动参数 |
| `DEFAULT_DESTRUCTIVE_PATTERNS` | 建议的 Settings 默认值，在整段命令里找：rm -r/-f、sudo rm、find -delete、git push -f/--force/+refspec、reset --hard、clean -f、checkout -- / .、restore、stash drop/clear、DROP/TRUNCATE/DELETE FROM 无 WHERE、FLUSHDB/ALL、mkfs、dd of=、写 /dev/sd*、chmod -R 777、kubectl delete、terraform destroy、.env |

## 各 agent 怎么启动

| agent | 新建 | resume | fork | 钩子 | “允许一次” |
| --- | --- | --- | --- | --- | --- |
| claude | `claude --session-id <新 uuid> --settings <json>` | `--resume <id>` | `--resume <id> --fork-session --session-id <新 uuid>` | `--settings` 里的 hooks | `Enter` |
| codex | `codex -c hooks.…（7 条）-c hooks.state={…}` | `codex resume <id> …` | `codex fork <id> …` | `-c` 覆盖 + 信任哈希 | `y` |
| shell | `$SHELL -l`；带命令时 `$SHELL -l -c <命令>` | 不支持 | 不支持 | 无 | 无 |
| custom | 按 shell 规则拆开的命令 | 不支持 | 不支持 | 无 | 无 |
| pi | `pi --session-id <新 uuid>` | `--session <id>` | `--fork <id> --session-id <新 uuid>` | `-e agentdeck-pi-extension.mjs`（0.80.4 起） | 不用（pi 从不请求批准） |
| omp | `omp`（会话 id 等扩展报） | `--resume <id>` | `--fork <id>`（新 id 等扩展报） | `-e agentdeck-pi-extension.mjs`（18.0 起，更早没验证） | `Up Enter`（读源码得出，**没在真终端核对**；发前先认屏） |
| kimi | `kimi` | `-S <id>` | 不支持 | 无 | 先不支持（2.3.1 是 `1`，见 known.ts） |

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
| session_start / turn_end / agent_end / session_compact / model_select 等（PL2） | AgentDeckUsage（`ctx.getContextUsage()` 的 tokens、contextWindow、percent，变了才发） | 不交给状态机，给用量模块 |

实测（2026-10-24，pi 0.83.0、omp 18.0.4）：临时 HOME、本地假的 OpenAI 兼容服务（不用账号、不花钱），`--mode rpc`（omp 的提问要 `--mode rpc-ui`）。
pi：SessionStart（就是 `--session-id` 给的 id）→ UserPromptSubmit → Stop → SessionEnd；`--session <id>` 接回、`--fork <id> --session-id <新>` 都报对了 id。
omp：`--approval-mode always-ask` 跑 bash，PermissionRequest 带上了 `command`，批准后 UserPromptSubmit、Stop；ask 工具 → Question（问题文字）→ 回答后 UserPromptSubmit → Stop；
`--resume <id>` 报原 id，`--fork <id>` 报新 id。没在真 TUI 里核对：omp 确认框“允许一次”的按键（PL1 按源码定为 Up Enter，发前先认屏，见下面）。
真窗口（单独的 AgentDeck 实例、临时 HOME、同一个假模型）：菜单列出 Pi、Oh My Pi；pi 一轮 running → idle → turn-end；omp 的 bash 批准显示 needs-approval（summary 是命令），
在确认框按 Enter 批准后 running → idle → turn-end；omp 新会话的 id 由 SessionStart 报上来存进库，`--resume <id>` 能接回（omp 只在第一条消息后才写会话文件，没说过话的会话接不回）。

## token 用量（PL2 · Usage 插件）

`src/usage/`：按终端找到 agent 自己的会话文件，只读新增部分（`JsonlTail` 记 offset，文件变短或换了就从头读），
每种 agent 一个读取器（`UsageParser.feed(line)` / `snapshot()`），认不出的行一律跳过，agent 不报的项是 null，不估。
**只读**：不写、不改 `~/.claude*`、`~/.codex`、`~/.pi`、`~/.omp`、`~/.kimi-code`。

```ts
const usage = new UsageServiceImpl({
  lookup: (id) => ({ terminalId: id, agent, sessionId, cwd, startedAt }), // 状态机的 agent / sessionId + store 的 cwd + 本次启动时间
  targets: () => [...],                     // 所有终端（kimi 推断时看同目录的其他 kimi 终端）
  emit,                                     // usage.changed
  roots: defaultUsageRoots(homedir(), loginEnv), // 认 CLAUDE_CONFIG_DIR、CODEX_HOME、PI_CODING_AGENT_DIR
});
createAgentRuntime({ ..., tapHook: (h) => usage.noteHook({ terminalId: h.terminalId, agent: h.agent, hookName: h.hookName, payload: h.envelope.payload }) });
// status.changed 时 usage.noteSession(id)（会话 id 变了，比如 codex 第一次输入、claude /clear）；退出时 usage.close()
```

- `get(id)` 读一次不留状态；`watch(id)` 之后每次有变化发 `usage.changed`（fs.watch 立即触发，节流 100ms；另有 1 秒一次的兜底轮询；
  还没找到文件时每 3 秒重找一次）；`unwatch(id)` 关掉监听、忘掉这个终端。
- 状态：`ok`；`no-data`（`Waiting for the session id` / `No session file yet` / `No usage recorded yet` / `Unknown terminal`）；`unsupported`（shell、自定义命令）。
- `USAGE_HOOK`（`AgentDeckUsage`）是 pi / omp 扩展报上下文用的钩子名，`tapHook` 返回 true，不交给状态机（免得清掉状态机的“输入后没有钩子”标记）。

| agent | 文件 | 累计 / 最近一次 | 上下文 | 窗口 | 对上终端 |
| --- | --- | --- | --- | --- | --- |
| claude | `projects/<cwd 非字母数字换成 ->/<id>.jsonl`，找不到时扫所有项目目录；钩子的 `transcript_path` 优先 | assistant 的 `message.usage`，按 `message.id` 去重（后来的行覆盖），`<synthetic>` 跳过；思考 = `output_tokens_details.thinking_tokens` | 最后一条主线回答的 input + cache_read + cache_creation；`compact_boundary` 后未知 | `CLAUDE_WINDOWS` 模型表（2.1.291 自带表）；上下文超过表里的值时按 1M（observed） | 会话 id（`--session-id` / SessionStart） |
| codex | `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`，从新往旧找 | `token_count` 的 total / last；input 减去 cached；请求数按 total_tokens 变化次数 | `last_token_usage.total_tokens`；`compacted` 后未知 | `model_context_window`（agent） | 会话 id（resume 的 id 或 SessionStart） |
| pi / omp | `sessions/*/<时间>_<id>.jsonl` | assistant 的 `message.usage`，0 用量（中断）不算；思考 = `reasoning` / `reasoningTokens` | 扩展报的 `getContextUsage()`；没报时最后一条的 totalTokens（窗口 null） | 扩展报的 `contextWindow` | 会话 id |
| kimi | `session_index.jsonl` → `<sessionDir>/agents/main/wire.jsonl` | `usage.record`（inputOther、output、inputCacheRead、inputCacheCreation），没有思考数 | 最新的 `token_counting.measured.tokens`，否则最后一次请求的输入 + 输出 | `config.toml` 的 `[models."<别名>"] max_context_size` | 有 id 时 exact；否则同目录、启动后创建的会话里最近活动的（inferred），更晚启动的同目录 kimi 终端拿走它启动之后建的会话 |

子 agent 的用量（claude 的 `<id>/subagents/`、kimi 的 `agents/<别的>/`）不算进去，只算主对话。
测试：`test/usage.test.ts`，样例在 `test/usage-fixtures/`（手写的小文件，不是真对话）。

## AgentDeck 的 MCP（M1）

`LaunchContext.mcp` 有值时 claude 适配器加 `--mcp-config <json>`：一个叫 `agentdeck` 的 http 服务，
`Authorization: Bearer ${AGENTDECK_MCP_TOKEN}`、`x-agentdeck-terminal: ${AGENTDECK_TERM}`，由 claude 从环境里展开（2.1.291 实测），
token 本身只放进 `LaunchSpec.env`，不进命令行。和用户自己配的 MCP 合并（不用 `--strict-mcp-config`）。

### N1：别的 agent 也挂（2026-10-25 核对）

规则：只用启动参数和环境变量，**不写用户自己的配置**（`~/.codex`、`~/.pi`、`~/.omp`、`~/.kimi-code`），也不往用户的仓库里放文件；token 不进命令行。
新建、resume、fork 都挂（服务没起来时 `LaunchContext.mcp` 为空，不挂）。

| agent | 支持 | 怎么挂 | 合并还是替换 | 依据 |
| --- | --- | --- | --- | --- |
| claude 2.1.291 | 是 | `--mcp-config <json>`，headers 里写 `${…}` | 合并 | M1 实测 |
| codex 0.164.0 | 是 | `-c mcp_servers.agentdeck.url="…"`、`-c …bearer_token_env_var="AGENTDECK_MCP_TOKEN"`、`-c …env_http_headers={"x-agentdeck-terminal"="AGENTDECK_TERM"}`（`codexMcpOverrides`）；`LaunchSpec.env` 带 token。命令行上只有环境变量的名字 | 合并（session flags 层按字段合并进用户配置） | 临时 `CODEX_HOME` 里 `codex mcp list` 用户的和 agentdeck 都在；`mcp get agentdeck --json` 是 streamable_http；mcp-server 的 real-codex 用 `codex app-server` 真的列出工具、调通 list_workspaces（调用者对） |
| omp 18.0.4 | 是 | `--plugin-dir <目录>`：目录是 `mcpPluginFiles()`（`.claude-plugin/plugin.json`，清单里内联 `mcpServers`，url、token、终端 id 都写成 `${AGENTDECK_MCP_URL}` 这类），组装时写一次（apps/desktop 写到 `<dataDir>/mcp-plugin`），经 `createAgentRuntime({ mcpPluginDir })` 传进来；`LaunchSpec.env` 带 `AGENTDECK_MCP_URL`、`AGENTDECK_MCP_TOKEN` | 合并（插件来源排最前，用户自己的、从 claude / codex 配置发现的照常在） | 源码：`cli/flag-tables.ts` 的 `--plugin-dir` → `discovery/helpers.ts` `injectPluginDirRoots` → `discovery/claude-plugins.ts` `loadMCPServers`（url、headers 走 `expandEnvVarsDeep`）。用 bun 调 omp 自己的 `injectPluginDirRoots` + `loadAllMCPConfigs`（XDG 目录指到临时目录）：得到 `agentdeck:agentdeck`，url 和两个 header 都展开了，用户原有的 3 个 MCP 也在。服务名是 `插件名:服务名` |
| pi 0.83.0 | 否 | — | — | pi 不内置 MCP：README 写 “No MCP.”、`docs/usage.md` 说故意不做，要用扩展自己实现。我们的 `agentdeck-pi-extension.mjs` 可以加一个 MCP 客户端（initialize + tools/list，用 `pi.registerTool` 注册代理工具），留到以后 |
| kimi 2.3.1 | 否 | — | — | `--help` 没有 MCP 参数，也没有 `mcp` 子命令。它只从 `$KIMI_CODE_HOME/mcp.json`、仓库根的 `.mcp.json`、`<cwd>/.kimi-code/mcp.json` 读；改 `KIMI_CODE_HOME` 会连账号和设置一起换掉，项目里的两个文件要写进用户的仓库，而且只在用户信任过这个目录时才读（`~/.kimi-code/workspace-trust/`），每个新 worktree 都要点一次。按会话加 MCP 只有 ACP（`kimi acp` 的 `session/new mcpServers`），TUI 用不上 |

- 版本：codex 低于 0.164.0 不挂（`-c` 里不认识的字段可能让整份配置加载失败、codex 起不来）；omp 低于 18.0.4 不挂。版本取不到时按够新处理（同钩子）。
- omp 在 tmux 里有没有真的连上、工具名在 omp 里显示成什么，没有在真 TUI 里核对（只核对了配置解析）。

`StartAgentRequest.prompt`（第一条消息）：claude、codex 都放在参数最后、`--` 之后（`--mcp-config` 和不少用户参数后面能跟多个值，不隔开会被吃掉）。只在新会话时带。

## Skills · MCP（N9，2026-10-25 核对）

源代码管理面板的 SKILLS · MCP 小节（不是插件，docs/plugins.md）。规则：**只用启动参数和环境变量**，不写用户自己的配置
（`~/.claude*`、`~/.codex`、`~/.pi`、`~/.omp`、`~/.kimi-code`），不往用户的仓库里放文件；只写 AgentDeck 自己的数据目录。

- 来源：built in（AgentDeck 自带：`agentdeck` skill，内容在 `builtinSkillFiles()`，组装方写到 `<数据目录>/builtin/skills`；`agentdeck` MCP 就是 M1 的服务）、
  repo（agent 自己会从仓库读的目录，从 cwd 往上到仓库根；只列出来，跟着仓库，不能开关）、library（`<数据目录>/skills/<name>/`、`<数据目录>/mcp/<name>.json`）。
- 默认（白板上没存选择）：built in 勾、library 不勾。规则在 contracts 的 `effectiveSkillSelection` / `skillsRestartNeeded`，界面和启动共用。
- `SkillsServiceImpl.prepareLaunch({ agent, cwd, selection })` → `LaunchSkills`（ids、agentdeckMcp、skills、mcp、setDir、keepSkillRoots），
  经 `createAgentRuntime({ skills })` → `AgentServiceImpl` → `AdapterLaunchContext.skills` 给适配器。没勾 built-in 的 agentdeck MCP 时不给 `LaunchContext.mcp`。
  出错时当作没有（照常启动，不带）。`onStarted` 报回 `StartedAgent.skills`，组装方 `noteLaunched` 记成 running（`stateFile`，重开应用后还在）。
- setDir：claude、omp、kimi 要一个目录：`<setsDir>/<agent>-<内容哈希>/`，`skills/<name>/` 是选中 skill 的副本，`.claude-plugin/plugin.json` 是清单
  （名字 `agentdeck-skills`；omp 的清单里还有库里的 MCP）。目录名按内容（含 skill 文件的大小、修改时间）算，一样就复用，不改正在用的目录；旧目录目前不清理。

| agent | skill（built in + library） | MCP（agentdeck + library） | repo 里它自己读的 | 核对 |
| --- | --- | --- | --- | --- |
| claude 2.1.291 | `--plugin-dir <setDir>`（只对这次会话）；skill 显示成 `agentdeck-skills:<name>` | `--mcp-config <json>`，agentdeck 和库里的写在同一份里，和用户自己的合并 | `.claude/skills` | `claude --plugin-dir <setDir> plugin details agentdeck-skills` 列出 Skills (2) agentdeck, e2e-demo（用本模块写出的目录） |
| codex 0.164.0 | **不支持**（面板写 Not supported for codex） | `-c mcp_servers.<name>.command=… -c ….args=[…]` 或 `.url=…`（`codexLibraryMcpOverrides`）；版本低于 0.164.0 不加 | `.agents/skills`、`.codex/skills` | 临时 CODEX_HOME 里 `codex -c … mcp list` 列出 e2edemo（npx -y …）；skill：`skills.config=[{path,enabled}]` 只开关已经发现的（app-server `skills/list` 实测加不进新的），加目录只有 app-server 的 `skills/extraRoots/set`，TUI 用不上；repo 两个目录 `skills/list` 实测都是 scope repo |
| omp 18.0.4 | 同一个 `--plugin-dir <setDir>`（可重复，排在 N1 的 mcp-plugin 后面） | agentdeck 照 N1；库里的写进 setDir 的清单 `mcpServers`，服务名 `agentdeck-skills:<name>` | `.omp/skills`、`.claude/skills`、`.codex/skills`、`.agents/skills`、`.agent/skills` | bun 跑 omp 自己的 `injectPluginDirRoots` + `loadCapability('skills' / 'mcps')`：列出 agentdeck、e2e-demo 和 `agentdeck-skills:e2edemo` |
| pi 0.83.0 | 每个 skill 一个 `--skill <文件夹>`（和自己发现的叠加） | **不支持**（No MCP） | `.pi/skills`、`.agents/skills` | `pi --mode rpc --no-session --skill <文件夹>` 的 `get_commands`（不发提示词）列出 `skill:e2e-demo`、`skill:agentdeck` |
| kimi 2.3.1 | `--skills-dir <setDir>/skills`；它会顶掉自动发现，所以把存在的 `$KIMI_CODE_HOME/skills`（默认 ~/.kimi-code/skills）、`~/.agents/skills`、`<仓库根>/.kimi-code/skills`、`<仓库根>/.agents/skills` 排在前面一起传；没选 skill 时不加 | **不支持** | `.kimi-code/skills`、`.agents/skills`（仓库根） | 只看了 `--help` 和打包的源码（`extraFileSkillSource.ts`：有 explicit 目录时 user、project 两组不再发现），**没在真 kimi 里核对**；传回去的项目目录按 user 来源加载，可能绕过 kimi 对项目目录的信任检查 |
| shell、custom | — | — | — | 小节写 “Skills and MCP servers are for agents” |

- 面板的状态点：只有 built in 的 agentdeck（AgentDeck 的 MCP 服务起来了是绿、没起来是红）；库里的 MCP 连没连上不知道，不画。
- 版本门槛：codex 的库里 MCP 同 N1（0.164.0），omp 的 setDir 同 N1（18.0.4）。版本取不到时按够新处理。running 记的是选中的 id，版本太低被适配器跳过的也算在里面（只影响 “Changes apply after restart” 的提示）。
- 测试：`test/skills.test.ts`（临时目录里的库、repo、每种 agent 列出什么、prepareLaunch 写的目录、每种 agent 的启动参数、running 存档、选择规则）。

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

## Auto-approve 和 Approve all（PL1、X3）

规则见 docs/plugins.md、DR-56，代码在 `src/status/approval.ts`（服务）、`support.ts`（每种 agent 的做法）、`auto-approve.ts`（开关）、`screens.ts`（omp 认屏）。

| agent | Auto-approve 怎么按 | Approve all | 核对 |
| --- | --- | --- | --- |
| claude | PermissionRequest 钩子回 allow（终端不进 needs-approval）；开关前就在等的、钩子回答没送到的发 `1` | 发 `1` | 钩子实测；按键见 DR-43 |
| codex | 同上，发 `y`（永远不发 p / a） | 发 `y` | 同上 |
| omp | 扩展报 PermissionRequest → needs-approval；屏幕上认出 `Allow tool:` 和 Approve / Deny 后发 `Up Enter` | 同左 | 18.0.4 源码，**没在真终端核对**（support 报 verified: false） |
| pi | 不用按（从不请求批准）；support 报 never-asks | — | — |
| kimi、shell、custom | 不支持（`setTerminalAutoApprove(id, true)` 抛 unsupported） | unsupported | — |

- 开关：框（`setAutoApprove`，框里的终端包括之后新开的，会清掉框里终端单独的设置）和单个终端（`setTerminalAutoApprove`，单独设置优先，null 跟着框）。
  打开时框里 / 这个终端已经在等的、不是破坏性的批准请求马上按。每次变化发 `approval.auto-approve-changed`（完整状态）。
- 不替你答：提问（question：AskUserQuestion、ExitPlanMode、codex request_user_input、MCP elicitation）、破坏性命令。
  开着 Auto-approve 的终端在等你时发 `approval.needs-you`（reason：destructive / question / couldnt-approve / unsupported；处理完或关掉时 reason 为 null），`autoApproveNeedsYou()` 取当前列表。
- 发键后 2 秒内状态没离开这条请求的 needs-approval 算 couldnt-approve；自动批准的同一条请求不重试，重新打开开关时会再试。
- `approve(ids, { by, includeDestructive })`：一条默认算 user（破坏性的也批），多条默认算 approve-all（破坏性的不批，返回 `destructive`，除非 includeDestructive）。同一条请求和 Auto-approve 撞上时只按一次。
- 记录：每次批准一条 ApprovalRecord（user / approve-all / auto-approve），内存里留最近 1000 条；给了 `approvalRecords` 就写进库，`history()` 从库里读。
- 开关状态本身只在内存里；随白板保存的是 `FrameNode.autoApprove`、`TerminalWindowData.autoApprove`，apps/desktop 启动、终端接回状态机之后按白板恢复一次。

## 测试

```bash
pnpm --filter @agentdeck/agent-adapters test        # 单元测试 + 钩子 socket 端到端（起真的 agentdeck-notify 子进程）
pnpm --filter @agentdeck/agent-adapters typecheck
# 用真的 claude / codex 跑整条链（默认跳过；要 tmux、claude、codex 并已登录；只问问题，权限请求会被拒绝）：
AGENTDECK_REAL_AGENTS=1 pnpm --filter @agentdeck/agent-adapters exec vitest run real-agents
```

- `test/fixtures.ts` 是实测抓到的钩子负载。agent 升级后先跑一次 real-agents，钩子格式变了就更新 fixtures 和解析。
- 终端用 `tools/fakes` 的 `FakeTerminalHost`；real-agents 里用一个只有 create 的 tmux 小实现（`tmux -L agentdeck-l4-real -f /dev/null`）。
