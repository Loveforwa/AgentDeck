# M1 的发现（给集成负责人，合并时整理进 docs/research/entries.py）

## 1. claude 会展开 `--mcp-config` 里的 `${环境变量}`（2.1.291 实测）

内联 JSON 的 `headers` 里写 `${AGENTDECK_MCP_TOKEN}`、`${AGENTDECK_TERM}`，claude 发请求时换成环境里的值。
所以 token 不用出现在命令行上（macOS 上别的用户能 `ps` 看到命令行，看不到环境）。
环境里没有这个变量时原样发 `${AGENTDECK_TERM}`，服务端当成“不在 AgentDeck 的终端里”。

## 2. 第一条消息要放在 `--` 后面

`--mcp-config <configs...>` 和 `--allowedTools` 这类参数后面能跟多个值，提示词直接跟在后面会被当成配置吃掉。
`claude … -- "<prompt>"`、`codex … -- "<prompt>"` 都实测可用。

## 3. `status.snapshot()` 不带 `workspaceId`

contracts 里 `StatusSnapshot.workspaceId` 是可选的，真实的 StatusMachine 和 tools/fakes 的 snapshot 都没填（只在 `status.changed` 事件里有）。
MCP 要知道“调用者在哪个工作区”，现在的做法：注入 `workspaceOf`（组装时接 `StatusMachine.get`）→ snapshot 的 workspaceId → 按终端当前目录找工作区。
建议线 4 在 snapshot 里也填上 workspaceId（只加不改）。

## 4. tmux `send-keys` 吃掉参数结尾的 `;`（tmux 3.6a 实测）

`TerminalHost.sendKeys` 不带 `-l`。参数结尾的 `;` 被当成命令分隔符；结尾是 `\;` 时反斜杠被吃掉（`find … \;` 打出来少一个 `\`）；
整段恰好是按键名（`Enter`、`C-c`）时当按键发。mcp-server 的 `literalKeys` 绕开了这些（见 AGENTS.md）。
如果以后要往终端里“原样打字”的地方变多，建议 TerminalHost 加一个带 `-l` 的方法（例如 `typeText(id, text)`），比各处自己转义稳。

## 5. 服务开的窗口不抢焦点

`BoardEvent` 两种都不抢键盘焦点、不动视口（用户可能正在别的终端里打字，焦点一换按键就打到别处）。只用 `highlight` 闪一下。
白板没开时（窗口全关了）事件没人收：终端在跑，但白板上没有它的窗口，下次打开也不会补上。组装时如果要处理，可以在主进程里记下来等界面起来再发。
