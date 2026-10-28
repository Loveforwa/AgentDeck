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
| `conversationExists(roots)` / `conversationCheckFromEnv(env)` | X4：fork 前找原来的对话文件（见「Fork 对话」）；runtime 默认按登录环境接好，`sessionRoots: null` 关掉 |
| `AgentServiceImpl` | `AgentService`（含 AH3 的 `check`）。`onStarted` 回调告诉状态机这次启动是否真的带上了钩子、钩子什么时候该来、一开始的降级原因；`cachedReport(agent)`、`noteLaunch(agent, reason)` 给 runtime 用 |
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
| `COMPAT_RECORDS` / `SCENARIOS` / `buildReport` / `strategyFromReport` / `HOOKS_DIDNT_REPORT` | AH2、AH3：合格测试记录（src/compat/records.ts，由 compat/*.json 生成）、K1–K18、能力报告的算法、按报告改 Auto-approve 做法、钩子没来时快照里的那句话 |
| `literalKeys` / `FirstMessageTyper` | AH1：启动后打第一条消息 |
| `DEFAULT_DESTRUCTIVE_PATTERNS` | 建议的 Settings 默认值，在整段命令里找：rm -r/-f、sudo rm、find -delete、git push -f/--force/+refspec、reset --hard、clean -f、checkout -- / .、restore、stash drop/clear、DROP/TRUNCATE/DELETE FROM 无 WHERE、FLUSHDB/ALL、mkfs、dd of=、写 /dev/sd*、chmod -R 777、kubectl delete、terraform destroy、.env |

## 各 agent 怎么启动

| agent | 新建 | resume | fork | 钩子 | “允许一次” |
| --- | --- | --- | --- | --- | --- |
| claude | `claude --session-id <新 uuid> --settings <json>` | `--resume <id>` | `--resume <id> --fork-session --session-id <新 uuid>` | `--settings` 里的 hooks | `1`（不发 Enter：用户按过方向键时 Enter 可能选成“以后都允许”） |
| codex | `codex -c hooks.…（7 条）-c hooks.state={…}` | `codex resume <id> …` | `codex fork -C <cwd> <id> …` | `-c` 覆盖 + 信任哈希 | `y` |
| shell | `$SHELL -l`；带命令时 `$SHELL -l -c <命令>` | 不支持 | 不支持 | 无 | 无 |
| custom | 按 shell 规则拆开的命令 | 不支持 | 不支持 | 无 | 无 |
| pi | `pi --session-id <新 uuid>` | `--session <id>` | `--fork <id> --session-id <新 uuid>` | `-e agentdeck-pi-extension.mjs`（0.80.4 起） | 不用（pi 从不请求批准） |
| omp | `omp`（会话 id 等扩展报） | `--resume <id>` | `--fork <id>`（新 id 等扩展报） | `-e agentdeck-pi-extension.mjs`（18.0 起，更早没验证） | `Up Enter`（发前先认屏；2026-10-28 在真 TUI 里核对，AH2 L2 的 K6） |
| kimi | `kimi` | `-S <id>` | 不支持（见「Fork 对话」） | 无 | 先不支持（2.3.1 是 `1`，见 known.ts） |

- 用户在 Settings 里加的启动参数放在最后。claude 的 LaunchSpec.env 带 `CLAUDE_CODE_TMUX_TRUECOLOR=1`。
- 恢复上次会话（X6）：白板按记下的会话 id 用上表的 resume 重开（`test/agent-service.test.ts` 逐个 agent 核对进 tmux 的参数）。`StartAgentRequest.prefill` 只对不带 command 的 shell 转给 `terminals.create`（Shell 在输入行里填好上次的命令、不运行），agent 和 `-c` 跑命令的 shell 忽略它。
- `--settings` 的值是一整段 JSON，**线 1 的 tmux-host 建会话时要按参数数组传**（`new-session … -- cmd arg1 arg2`），不要拼成一行 shell 命令，否则要自己转义。
- 检测：在传入环境的 PATH 里找命令，跑 `--version` 取 x.y.z。版本取不到时**不当作够新**（AH3）：再读一次 `--help`，要带的参数在里面才带（`env.ts` 的 `atLeast(version, min, help)`），见「运行时降级」。
- claude 的钩子要 2.0 以上（粗略下限），StopFailure 事件只在 2.1 以上加；codex 的钩子要 0.159 以上（本机实测的版本，更早的没验证）。
- “允许一次”的按键是看确认框得出的（claude “❯ 1. Yes”，发 `1`；codex “1. Yes, proceed (y)”，发 `y`）；线 1 用真终端核对过 send-keys 的效果（tmux-host/AGENTS.md「Approve all 的按键核对」）。

## Fork 对话（X4，DR-42，2026-10-26 实测）

用法：W5 对话框的 Fork、终端标题栏菜单的 Fork conversation into…（packages/ui/canvas）调 `agents.start({ mode: { kind: 'fork', sessionId } })`，
cwd 是目标工作区的目录。原来的终端和对话都不动。

**跨目录不用复制会话文件**：DR-42 担心 claude 换了目录找不到原会话，实测不会，所以没做“先把记录复制到新目录”的兜底。

| agent | 跨目录 fork | 怎么核对的 |
| --- | --- | --- |
| claude 2.1.291 | 可以。`--resume <id>` 在所有项目目录里找；`--fork-session --session-id <新>` 把副本写进 `projects/<新 cwd>/<新 id>.jsonl`，每行的 cwd 改成新目录，原文件不变 | 真 CLI：目录 A 里 `claude -p … --session-id <A>` 记一个暗号，目录 B 里 `claude -p … --resume <A> --fork-session --session-id <B>` 答出暗号；tmux 里的 TUI 也一样（A 的终端开着，B 里 fork 后问暗号和 cwd，答对、cwd 是 B，A 那边没多出消息） |
| codex 0.164.0 | 可以，但 **TUI 要 `-C <cwd>`**：不写时 cwd 和会话记下的不同，先弹 “Working directory · fork”（Use session directory / Use current directory / Always …），默认选中原来的目录；写了 `-C` 就直接用新目录、不弹 | 真 CLI：A 里 `codex exec`，B 里 `codex exec fork <id> "…"` 答出暗号、报的 cwd 是 B；tmux 里 `codex fork <id>` 弹了上面的框，`codex fork -C <B> <id>` 没弹、显示 “Thread forked from …” |
| pi 0.83.0 | 可以。`--fork <id>` 先找本目录、再找所有项目（dist/main.js `resolveSessionPath`），`SessionManager.forkFrom` 写进新目录的 sessions 子目录、header 的 cwd 是新目录 | 真 CLI，不调模型：临时 `PI_CODING_AGENT_DIR`，用 pi 自己的 SessionManager 在 A 写一段两条消息的会话，B 里 `pi --mode rpc --fork <id> --session-id <新>`，`get_messages` 返回原来的两条，`get_state` 的 sessionFile 在 B 的目录下 |
| omp 18.0.4 | 可以。`resolveResumableSession` 本目录没有时找全部（没给 `--session-dir` 时），`forkFrom` 写进新目录 | 真 CLI，不调模型：临时 `PI_CODING_AGENT_DIR`，bun 跑 omp 的 SessionManager 在 A 写会话，B 里 `omp --mode rpc --fork <id>`：B 的目录下多了新会话（header cwd 是 B、parentSession 是原 id、两条消息都在）。omp 随后因为没有模型退出，**TUI 里没核对** |
| kimi 2.3.1 | 不支持。有 `kimi fork [id]` 子命令（不进 TUI，打印 “Forked to <新 id>”），要先跑它、再 `kimi -S <新 id>` 两步，新会话记在哪个目录没核对 | `kimi fork --help` 和打包的源码 `src/cli/sub/fork.ts`；没跑 |

- **还没说过话的会话不能 fork**：claude、pi、omp 第一条消息之后才写会话文件（codex 的 id 本来就要等第一次输入），这时 agent 报
  “No conversation found with session ID …” 直接退出（claude 2.1.291 实测）。所以 `AgentServiceImpl.start` 在 fork 前调 `conversationExists`
  （`src/fork.ts`，复用用量模块的 `locateClaude` / `locateCodex` / `locatePi`，只读），确定没有时抛 `not-found`
  “No conversation to fork yet. Send <label> a message first.”，不开终端；找不到目录、出错、kimi 等返回 null 时照常启动。
  目录按登录 shell 环境的 HOME、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`PI_CODING_AGENT_DIR` 推（`createAgentRuntime` 的 `sessionRoots` 可以覆盖，null 不查）。
- fork 出来的会话 id：claude、pi 是 AgentDeck 生成的新 id（启动时就知道）；codex、omp 等 SessionStart 报上来。
- 测试：`test/fork.test.ts`（每种 agent 的 fork 参数、临时目录里的假会话文件、找不到时不开终端、runtime 的开关）。
- 实测时 claude、codex 自己在 `~/.claude/projects/`、`~/.codex/sessions/` 里留下了测试会话，没有去删（不改 agent 自己的目录）。

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
`--resume <id>` 报原 id，`--fork <id>` 报新 id。omp 确认框“允许一次”的按键（PL1 按源码定为 Up Enter）2026-10-28 在真 TUI 里核对过（AH2 L2 的 K6）：标题在上边框里（`╭─ Allow tool: bash ──╮`），命令前有 `Command: `，按完命令照常运行。
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

- 版本：codex 低于 0.164.0 不挂（`-c` 里不认识的字段可能让整份配置加载失败、codex 起不来）；omp 低于 18.0.4 不挂。版本取不到时看 `--help` 里有没有 `--plugin-dir`（codex 的 `-c mcp_servers` 看不出来，不挂；AH3）。
- omp 在 tmux 里有没有真的连上、工具名在 omp 里显示成什么，没有在真 TUI 里核对（只核对了配置解析）。

## 第一条消息（`StartAgentRequest.prompt`，AH1，IS-76）

只在新会话时带（resume、fork 照旧不带）。适配器在 `LaunchSpec.consumed.prompt` 报有没有放进启动参数；没放进、也没给
`LaunchSpec.sendAfterReady` 时，`AgentServiceImpl.start` 抛 `unsupported`
“<Label> can't take a first message yet. Open it without "prompt", or pick an agent that can (see Settings › Agents).”，**不开终端**；
MCP 的 open_terminals / create_workspace 把这句原样返回给调用的 agent。

| agent | 怎么带 | 核对（2026-10-28） |
| --- | --- | --- |
| claude | 参数最后、`--` 之后（`--mcp-config` 和不少用户参数后面能跟多个值，不隔开会被吃掉） | 2.1.291 实测（M1） |
| codex | 同上（`codex [PROMPT]`） | 0.164.0 |
| omp | 同上：omp 认 `--`，之后的 @、- 开头的也照原文 | 18.0.4 真 TUI：`omp -- '@README.md reply with the word PELICAN'`，假模型收到原文（omp 另外附上了 README.md，和在输入框里打 @ 一样） |
| pi | 不认 `--`（会被当成名字为空的未知参数、吃掉下一项），所以放在用户的额外参数**前面**；开头是 @（文件）或 -（参数）时前面加一个空格 | 0.83.0 真 TUI：`' @README.md …'`、`' --help me …'` 原文（多一个空格）送到假模型；不加空格的 `@README.md say …` 被当成文件，pi 直接退出 |
| kimi | 交互模式没有这个参数（`-p` 是一次性问答）：`sendAfterReady`，AgentService 等终端第一次安静下来（monitor-silence）后 `sendKeys` 打字，停 500ms 再回车（`src/first-message.ts`）。屏幕上有 “Trust this folder?” 时等下一次安静（回车会替用户选 Trust and continue）。能力报告里是 Partial · Typed after start | 2.3.2 真 TUI（临时 `KIMI_CODE_HOME`、假模型）：`@README.md reply with the word PELICAN` 原文送到；新目录第一次打开先弹信任框 |
| shell、custom | 带不了，报 unsupported | — |

- 打字用 `literalKeys(text)` 转成 sendKeys 的参数（tmux-host 的 sendKeys 不带 `-l`）：控制字符换成空格；结尾的 `;` 写成 `\;`（tmux 把以 `;` 结尾的参数当命令分隔符）；
  没有空格的一段可能正好是按键名（Enter、Up……），拆成一个字一个参数。TerminalHost 以后有 `send-keys -l` 的方法时换成它。
- 等待：终端一直不安静时 20 秒后照样看一次屏幕再打；终端退出了就不打。要组装方把 TerminalHost 的事件交给 `rt.onTerminalEvent`（已经接好）。

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
- 版本门槛：codex 的库里 MCP 同 N1（0.164.0），omp 的 setDir 同 N1（18.0.4）。版本取不到时看 `--help` 里有没有那个参数（AH3）。running 记的是选中的 id，版本太低被适配器跳过的也算在里面（只影响 “Changes apply after restart” 的提示）。
- 测试：`test/skills.test.ts`（临时目录里的库、repo、每种 agent 列出什么、prepareLaunch 写的目录、每种 agent 的启动参数、running 存档、选择规则）。

## 历史会话（N11，DR-62，2026-10-26 本机核对）

`src/history/`：`HistoryServiceImpl.list()` 列出这台电脑上各 agent 的历史会话（只读）。每种 agent 一个读取器（`readers.ts`），只读文件开头（claude 还读结尾 64KB 找标题）；按“路径 + 修改时间 + 大小”缓存，第一次扫全机（本机 1200 多个文件）约 0.3 秒，之后几毫秒。

- 不列：claude 的 sdk-*（claude -p、SDK）、codex 的 exec / mcp / 子 agent（source 是对象）、没说过话的空会话；claude 只看 `projects/*/*.jsonl`，不进 `<id>/subagents/`。
- 标题：自己起的名字（claude custom-title、kimi isCustomTitle）> agent 起的（claude ai-title、codex session_index.jsonl 的 thread_name、omp title / title_change、kimi title）> 第一条消息。
- omp 文件第一行是 title 行（固定位置补空格），session 行在第二行；claude 在不是 git 仓库的目录里把分支记成 HEAD，按没有分支处理。
- 测试：`test/history.test.ts`（手写的小样例）。

## 后台 agent（N10，DR-61，2026-10-26 实测 claude 2.1.291）

`src/subagents/`：agent 自带的子 agent（claude 的 Agent / Task 工具开的），按终端列出来，只读，不保存。现在只有 claude，别的 agent 的钩子直接忽略。

- 钩子：`SubagentStart`（agent_id、agent_type）、`SubagentStop`（再加 agent_transcript_path、last_assistant_message）。只在 claude ≥ 2.1 时注入（`MIN_SUBAGENT_HOOKS_VERSION`）。
- **只认见过 SubagentStart 的**：claude 自己的内部查询每轮会单独发一两个 `SubagentStop`，没有 agent_type、没有 Start，不能列出来。
- 后台 agent 做完时 claude 给主 agent 发一条 `<task-notification>`（task-id、status、subagent_tokens、duration_ms），走的是 `UserPromptSubmit`，所以 UserPromptSubmit 不一定是用户发的消息（`isClaudeSyntheticPrompt`）。真的用户消息才把做完的标成“不是这一轮”（`current: false`）。
- `Stop` / `SubagentStop` 的负载带 `background_tasks`（id、description、status），meta.json 还没写时先从这里补任务描述。
- 记录：`<会话文件去掉 .jsonl>/subagents/agent-<id>.jsonl`，旁边 `agent-<id>.meta.json`（agentType、description、requestShape）。跑着的、有人看着记录的每秒读一次新增部分。

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
| omp | 扩展报 PermissionRequest → needs-approval；屏幕上认出 `Allow tool:` 和 Approve / Deny（Approve 要是第一项）后发 `Up Enter` | 同左 | 18.0.4 源码 + 2026-10-28 真 TUI（AH2 L2 的 K6，support 报 verified: true） |
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

## 能力声明和合格测试（AH0、AH2，画布 A0、A1）

- **能力声明**：每个适配器实现 `declareCapabilities(version)`（contracts 的 `CapabilityEntry[]`）：每项 yes / partial / no、via、不是 yes 的原因（英文，界面原样用）。
  claude、codex 写在各自的文件里，pi、omp、kimi 是 known.ts 每行的 `declared`（扩展没给、版本太老时通用适配器把靠扩展的几项改掉），shell、custom 只有几项 no。
  只写做了什么、靠什么做；没核对过的写 partial 并说明，没做的写 no 并说明。image-input、video-input、invoke-skill、clear-context 留给 RS14、LR2、LR7。
- **合格测试**：一张表 K1–K18（`src/compat/scenarios.ts`，每项对应一个能力），按声明逐项跑：声明 no 的跳过（没写原因算失败），yes / partial 的必须过。
  - L1（`test/conformance/l1.test.ts`，在 `pnpm check` 里）：假 PATH 里的假程序、实测抓到的钩子负载、样例会话文件。启动参数和按键对照
    `test/conformance/verified.ts`（真程序上核对过的标准答案，和适配器代码分开写），改了参数对应的 K 会失败。另外核对旧的 AgentCapabilities、AutoApproveSupport 能由声明推出。
  - L2（`test/conformance/l2.test.ts`）：真程序在 `tmux -L agentdeck-conformance -f /dev/null` 里，`AGENTDECK_REAL_AGENTS=1 pnpm --filter @agentdeck/agent-adapters conformance [--agent pi]`。
    pi、omp、kimi 接本地假模型（`support/fake-model.ts`，临时 HOME，不用账号、不花钱）；claude、codex 用登录的账号，只问不改文件的问题（批准请求一律 Esc 拒绝），五轮以内的短对话。
    目录在本包的 `.conformance/`（.gitignore 里），在信任过的仓库里不弹信任框。omp 的首次设置向导、pi / kimi 的信任框由测试脚手架代替用户处理。
  - 跑完写 `compat/<agent>.json`（版本、日期、每项 pass / fail / skip 和原因、每项的 verifiedUpTo；pass 才前进，fail 不前进），再生成 `src/compat/records.ts`（运行时读它）。
    L2 不跑、但以前手工在真程序上核对过的项记成 `suite: manual`（原因里写怎么核对的），L2 跳过时保留。手改记录后跑 `… conformance --records`。
  - `.github/workflows/agents-conformance.yml`：手动触发，装 pi、omp 最新版跑 L1 + L2，记录作为 artifact 上传。
- K18（IS-144）：AgentDeck 生成的参数里没有让 agent 自己另开 worktree 的（claude `--worktree`/`-w`/`--tmux`、codex `--worktree`、omp `--cwd`），终端的目录就是框的目录；
  L2 里再看窗格的当前目录、claude 钩子负载里的 cwd、`git worktree list` 没多出来。用户在 Settings 里自己加的参数不管。

## 运行时降级（AH3，DR-60 P0，画布 A0 的规则、A1）

能力报告（`AgentInfo.report`、`agents.check` 的返回值）= 适配器的声明 + 合格测试记录 + 运行时的情况，在 `src/capabilities/report.ts`：

- **verifiedUpTo**：这一项对应的 K 在 `compat/<agent>.json` 里通过的最低版本（有一项从没通过就是 null；跳过的不算）。没有 K 的能力为 null。
- **版本超过核对版本**（比记录新、读不出版本、没有记录）：替你按东西的（`approve-keys`，以及靠认屏 `screen` 的）降为 no，`downgrade: 'off'`，
  reason “Untested on <版本>”（读不出版本时 “Untested: couldn't read the <Label> version”）。钩子、扩展、会话文件、启动参数（A、B 档）照常，
  界面拿 `report.version` 和 `verifiedUpTo` 比，自己写 “newer than checked”。`createAgentRuntime` 给 ApprovalService 的策略跟着报告走
  （`strategyFromReport`）：omp 超过 18.0.4 时 Auto-approve / Approve all 报 unsupported、note 是同一句，开着 Auto-approve 的终端发
  `approval.needs-you`（reason unsupported），不发键（TC-48）。kimi 的第一条消息也是按键打进去的，但只是打字，不关。
- **版本读不出**：不再当作够新（`env.ts` 的 `atLeast`）。检测时再读一次 `--help`：claude 有 `--settings` 才带钩子，pi / omp 有 `-e` 才带扩展，
  omp 有 `--plugin-dir` 才挂 MCP、带 skill，kimi 有 `--skills-dir` 才带 skill；codex 的钩子、MCP 从 help 看不出来，不带（也不带会顶掉用户 notify 的 legacy notify）。
- **钩子该来没来**（IS-74，状态表第 20–23 行）：claude、pi、omp 启动后 10 秒、codex 第一次输入后 10 秒没有任何钩子，这个终端改按输出判断，
  `StatusSnapshot.degraded` 写 “Hooks didn't report · status from terminal activity”，报告的 status 一项写 Partial · output “Hooks didn't report at the last launch”；
  之后钩子来了恢复（这个终端回到钩子规则，下一次有钩子的启动清掉报告里的说明）。没有钩子的 agent（kimi）一开始就带 “Status from terminal activity · Kimi has no hooks”。
- **启动参数被拒**（IS-73）：版本没核对过、这次运行里也还没正常起来过的那次启动，等 3 秒：非 0 退出、输出里有 unknown option / unrecognized / unexpected argument 之类时，
  收掉它，用 `AdapterLaunchContext.sessionOnly` 只带会话参数（新建 / 接回 / fork 的 id 和第一条消息）重开一次，返回新的终端；不带钩子、MCP、skill、用户的额外参数。
  终端标降级（“Started with session options only · <那一行>”），报告的 status 写同一句，`AgentInfo.warning` 也是它。同一版本之后直接只带会话参数，不再等。
  核对过的版本不等（每次启动不会多 3 秒）；起来过一次的版本也不再等。
- **agent 自己升级了**（IS-77）：启动前看可执行文件的修改时间，变了就重读这一家（版本、help、报告）；codex 的信任哈希缓存按“notify 路径 + codex 路径 + 修改时间”存。
  本机 kimi 会自己在后台升级（合格测试期间从 2.3.2 升到了 2.3.3）。
- **Check again**（`agents.check`）：重读版本；在 `--help` 里找每次会带的参数（`launchFlags()`），没有的那几项 no、`downgrade: 'failed'`、reason “--plugin-dir isn't in claude --help”；
  有钩子、不是 codex、知道上次在哪个目录启动过时，在那个目录带钩子空启动一次（不发提示词），等 10 秒钩子再关掉：来了清掉 status 的说明，没来写 “Hooks didn't report when checked”。
  空启动的终端不交给状态机（runtime 的 `waitForHook`）。不写 agent 自己的配置。
- 没做：IS-75（回了 allow 后几秒内没有 PostToolUse / Stop 就退回 needs-approval），重开应用接回终端时按那次启动实际带没带钩子（要 apps/desktop 记下来）。
- 测试：`test/degradation.test.ts`（TC-48、读不出版本、参数被拒、升级后重读、Check again、钩子没来）、`test/status-machine.test.ts`（第 20–23 行）、合格测试 L1 的 K16、K17（K17 用真子进程跑会拒参数的假程序）。

### 新增或升级一家 agent（五步）

1. **加一行或写适配器**：known.ts 加一行（命令名、启动参数模板、扩展、第一条消息怎么带、能力声明）；钩子、扩展、读文件不够时才写专门的适配器。参数先用真程序核对（`--help`、源码、真跑一次）。
2. **写能力声明**：每项 yes / partial / no、via、原因（`declareCapabilities`）。
3. **L1**：在 `verified.ts` 加这家的标准答案（版本、会话参数、第一条消息、按键……），`pnpm --filter @agentdeck/agent-adapters test` 全过。L1 的钩子负载、会话文件样例不够时补进 test/fixtures.ts、test/usage-fixtures/。
4. **L2**：`AGENTDECK_REAL_AGENTS=1 pnpm --filter @agentdeck/agent-adapters conformance --agent <id>`（能接假模型的在 l2.test.ts 的 PROFILES 里加一份临时配置；要账号的只问不改文件的问题）。
5. **提交记录**：`compat/<agent>.json` 和 `src/compat/records.ts` 一起提交。升级时同样跑 3–5，记录前进后，超过核对版本时关掉的功能（AH3）自动回来。

### 合格测试结果（2026-10-28，本机）

| agent | 版本 | pass | fail | skip | 说明 |
| --- | --- | --- | --- | --- | --- |
| claude | 2.1.291 | 16 | 0 | 2 | K13 不读额度；K17 L2 不跑（L1 用假程序覆盖）。K6、K14、K15 是以前手工核对的（manual） |
| codex | 0.165.0 | 15 | 0 | 3 | K8 没有提问工具；K15 不支持；K17。K6（0.159.2）、K14（0.164.0）是 manual |
| pi | 0.83.0 | 12 | 0 | 6 | K5、K6、K8 pi 不问；K13；K14 没有 MCP；K17。K15 是 manual |
| omp | 18.0.4 | 15 | 0 | 3 | K6 第一次在真 TUI 里核对（确认框标题在上边框里，见 screens.ts）；K13；K14 只核对了配置解析；K17。K15 是 manual |
| kimi | 2.3.3 | 9 | 0 | 9 | 本机 kimi 跑测试期间自己从 2.3.2 升到了 2.3.3。K5、K6、K8 不认等待；K10 不能 fork；K13；K14；K15 没在 kimi 里核对；K16 没有钩子；K17 |

## 测试

```bash
pnpm --filter @agentdeck/agent-adapters test        # 单元测试 + 钩子 socket 端到端（起真的 agentdeck-notify 子进程）
pnpm --filter @agentdeck/agent-adapters typecheck
# 用真的 claude / codex 跑整条链（默认跳过；要 tmux、claude、codex 并已登录；只问问题，权限请求会被拒绝）：
AGENTDECK_REAL_AGENTS=1 pnpm --filter @agentdeck/agent-adapters exec vitest run real-agents
```

- `test/fixtures.ts` 是实测抓到的钩子负载。agent 升级后先跑一次 real-agents，钩子格式变了就更新 fixtures 和解析。
- 终端用 `tools/fakes` 的 `FakeTerminalHost`；real-agents 里用一个只有 create 的 tmux 小实现（`tmux -L agentdeck-l4-real -f /dev/null`）。
