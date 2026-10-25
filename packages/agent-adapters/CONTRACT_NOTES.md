# 对 contracts 0.1.2 的意见（线 4 写适配器和状态机时发现）

> **已处理（2026-10-23，contracts 0.1.3，提交 68024ca）**：第 1 条选了 `CreateTerminalRequest.id`（由 AgentService 先生成），第 2–6 条都加进了 contracts（`LaunchContext.command`、`StatusSnapshot.sessionId`、`terminal.input` 事件、`tool-done`、`AgentInfo.warning`），第 7–9 条写进了注释。本包改用这些新字段（去掉 `CommandLaunchContext`、`PENDING_TERMINAL_ID`、`hookHint`）待线 4 跟进；`terminal.input` 由线 1 的 tmux-host 发。

没有改 `packages/contracts`。下面是接口不够用或说得不清的地方，交给集成负责人决定；每条都写了本包现在的临时做法。

## 需要加东西（都是只加不改）

### 1. LaunchContext.terminalId 在启动前拿不到
- 注释说“这个终端将使用的 id”，但 id 是 `TerminalHost.create` 分配的，`CreateTerminalRequest` 没法指定 id，所以 launch 时不可能知道。
- 现在没有适配器用它：钩子靠 tmux 给窗格设的 `AGENTDECK_TERM` 认终端。
- 建议：把 `LaunchContext.terminalId` 改成可选并注明“目前总是空”，或者给 `CreateTerminalRequest` 加可选的 `id?: TerminalId`（由调用方生成）。
- 现在怎么做：传占位值 `PENDING_TERMINAL_ID = 'pending'`。
- 影响：线 1（如果选加 id）、线 4。

### 2. LaunchContext 没有“要运行的命令”
- Shell 带命令（setupCommand、pnpm dev）和自定义命令需要 `StartAgentRequest.command`，但 `launch(ctx)` 拿不到。
- 建议：`LaunchContext.command?: string`。
- 现在怎么做：本包的 `CommandLaunchContext extends LaunchContext { command?: string }`，AgentService 传进去。

### 3. codex 的会话 id 界面拿不到
- codex 的会话 id 要等 `SessionStart` 钩子，而且实测**第一次输入之后**才来；`StartAgentResult.sessionId` 是 null，`StatusSnapshot` 里也没有会话 id。
  界面和 store 没有办法把它存进 `TerminalWindowData`，后面 resume / Fork（X4、X6）就做不了。claude 没这个问题（我们自己生成）。
- 建议二选一：`StatusSnapshot.sessionId?: AgentSessionId | null`；或新事件 `{ type: 'agent.session'; terminalId; sessionId }`。
- 现在怎么做：`StatusMachine.get(id).sessionId` 能取到（主进程内部），没有对外。

### 4. 状态机需要“用户输入了”这个信号
- claude 里拒绝批准（Esc 或选 No）、运行中按 Esc 打断，**都不触发任何钩子**（实测，见 AGENTS.md）。不兜底的话状态会一直停在 needs-approval / running。
- 现在怎么做：`StatusMachine.noteInput(terminalId)`，组装时由 IPC 层在 `terminals.write` / `sendKeys` 后调用；之后 3 秒没输出且没有钩子 → idle（状态表第 15 行）。
- 建议：如果希望各线都按 contracts 接，加一个 `TerminalEvent`：`{ type: 'terminal.input'; id: TerminalId; at: IsoTime }`（由 tmux-host 或 IPC 层发）。优先级中。

### 5. AgentHookEvent 少一个“工具跑完了”
- 批准或回答之后要回到 running，靠的是 `PostToolUse`。现在映射成 `prompt-submitted`，语义不准，而且丢了“是哪个工具”：
  claude 会并行跑工具，别的工具跑完不该清掉还在等的批准。
- 建议：`{ type: 'tool-done'; tool: string | null; summary: string }`。
- 现在怎么做：仍发 `prompt-submitted`，另外由 `hookHint()` 从原始负载算出跑完的工具的 summary，作为 `StatusMachine.onHook` 的第三个参数（状态表第 8b 行）。

### 6. 钩子被关掉时没法提示
- 需求说“agent 升级改了钩子格式时……在 Settings › Agents 里提示”。用户设了 `disableAllHooks`、或 agent 换了格式时，我们收不到钩子，
  但 `AgentInfo.capabilities.hooks` 仍然是 true，界面不知道。
- 建议：`AgentInfo.warning?: string`（英文，例如 "Hooks are disabled in your Claude settings; status uses terminal activity."），或在 StatusSnapshot 上加 `degraded?: boolean`。
- 现在怎么做：没做。启动后一段时间没收到 SessionStart 就退回“看输出活动”可以在状态机里做，等定了接口再加。

## 需要说清楚（只改注释）

### 7. AskUserQuestion 走的是 PermissionRequest
- claude 的提问工具是以 `PermissionRequest`（`tool_name: AskUserQuestion`）来的。适配器把它转成 `question`，所以 `HookServer` 的 `decide`
  看到的 `event.type` 是 `question`。P1 的 Auto-approve 只能对 `event.type === 'permission-request'` 回 allow，否则会替用户回答问题。
- 建议在 `HookReply` 注释里写明：“只对批准类请求回 allow；提问永远 none”。

### 8. `TerminalStatus` 的 starting 对 codex 会比较久
- codex 的 SessionStart 要等第一次输入。有输出就离开 starting（变 running，3 秒后 idle），不依赖 SessionStart。只是说明，不用改。

### 9. 没有钩子的程序要不要发 agent.turn-end
- `agent.turn-end` 注释是“一轮结束”。Shell、自定义命令没有“一轮”，现在 running → idle 时**不发**（免得 dev server 每次停下都刷新源代码管理面板）。
  如果线 3 希望 Shell 里跑完 git 命令也刷新，可以改成发，或者另加事件。建议在注释里写明现在的做法。
