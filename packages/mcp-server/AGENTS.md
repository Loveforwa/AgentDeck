# @agentdeck/mcp-server

AgentDeck 自己的 MCP 服务（任务 M1）。白板里的 agent 通过它开终端、开工作区、开网页、看和指挥别的终端。只在**主进程**里用。

- HTTP（streamable HTTP，无状态），只听 `127.0.0.1`，固定端口 `47621`，被占用时换随机端口。
- 用到的服务（projects、workspaces、agents、terminals、status）和白板事件出口都由构造参数注入，类型来自 contracts，不 import 别的服务包。
- 挂到 agent 上：`packages/agent-adapters` 的 claude 适配器（`LaunchContext.mcp` → `--mcp-config`）。codex 暂时不挂。

不许碰：`packages/contracts`（不够用先停下，见它的 AGENTS.md）、其他包。

## 工具

工具名、参数、返回文字都是英文。返回值是 JSON 文本；服务抛的错变成 `isError` 加一句英文。

| 工具 | 做什么 | 默认 |
| --- | --- | --- |
| `list_workspaces` | 项目和工作区，调用者所在的工作区标 `current` | |
| `list_terminals` | 终端和状态（含在等什么），调用者自己标 `self`；可按工作区过滤 | |
| `open_terminal` | `agents.start` 开 agent 或 Shell，再让白板把窗口放进框里；可带第一条消息 `prompt` | 调用者的工作区，agent 为 claude |
| `create_workspace` | `workspaces.create` 新建 worktree 和分支 → 框放上白板 → 有初始化命令先开 Shell 跑 → 开 agent（带 `prompt`） | 调用者的项目，agent 为 claude，`none` 不开 |
| `open_browser` | 白板开网页窗口，同一个 origin 复用已开的窗口 | 调用者的工作区 |
| `read_terminal` | 别的终端最后 n 行（最多 500） | 60 行 |
| `send_to_terminal` | 往别的终端打字，再按回车；不能发给自己 | `submit: true` |

“调用者的工作区”：先问注入的 `workspaceOf`（组装时接状态机），再看 `status.snapshot` 的 `workspaceId`，最后按终端当前目录找路径最长的工作区。

## 认证和调用者

- `Authorization: Bearer <token>`。token 是 `~/.agentdeck/run/mcp-token`（0600）里的 64 位十六进制数，`loadOrCreateToken` 读或生成；存下来是为了 AgentDeck 重启后，tmux 里还活着的 agent 不用重开。
- `x-agentdeck-terminal: <终端 id>`：调用者是哪个终端。
- claude 的配置里两者都写成环境变量（`${AGENTDECK_MCP_TOKEN}`、`${AGENTDECK_TERM}`），claude 自己展开（2.1.291 实测），所以 token 不出现在命令行上。环境里没有 `AGENTDECK_TERM` 时 claude 原样发 `${AGENTDECK_TERM}`，当成不在 AgentDeck 的终端里。
- 带 `Origin` 的请求（网页）一律 403；`Host` 不是本机的也 403（防 DNS rebinding）。
- 无状态：每个请求新建 McpServer 和 transport，不发 `Mcp-Session-Id`。AgentDeck 重启后只要端口没变，agent 的下一次调用照常能用。

## 白板事件

终端、工作区由服务建好后发 contracts 的 `BoardEvent`，白板（`packages/ui/canvas`）放上去：

- `board.add-frame`：工作区放到空位上。
- `board.open-window`：窗口放进框里；`highlight` 时闪一下。不抢键盘焦点、不动视口。

白板没开（窗口都关了）时事件没人收，终端照常在跑，但白板上没有它的窗口。

## send_to_terminal 怎么保证原样打出来

`TerminalHost.sendKeys` 是 tmux `send-keys`（不带 `-l`），`literalKeys` 负责转义（tmux 3.6 实测）：

- 换行换成空格（换行会被 agent 当成提交）。
- 没有空白的文字按单个字符发：整段恰好是按键名（`Enter`、`C-c`）时 tmux 会当按键发。
- 参数结尾的 `;` 是 tmux 的命令分隔符，会被吞掉（`find … \;` 的反斜杠也会被吃），所以结尾的分号拆出来单独发 `\;`。
- 文字和回车分两次发，中间等 150ms，agent 才不会把回车当成粘贴里的换行。

## 组装（apps/desktop 主进程）

```ts
import { loadOrCreateToken, startMcpServer } from '@agentdeck/mcp-server';

const mcp = await startMcpServer({
  token: await loadOrCreateToken(join(homedir(), '.agentdeck/run/mcp-token')),
  projects, workspaces, agents: rt.agents, terminals, status: rt.status,
  workspaceOf: (id) => rt.status.get(id)?.workspaceId,
  onInput: (id) => rt.noteInput(id),
  emit: (e) => emit(e),          // 广播给界面
  homeDir: homedir(),
});
// agent-adapters：createAgentRuntime({ …, mcp: () => mcp.endpoint })
// 退出前：await mcp.close()
```

## 测试

```bash
pnpm --filter @agentdeck/mcp-server test        # 真的 HTTP + SDK 的 Client，后面是 tools/fakes
pnpm --filter @agentdeck/mcp-server typecheck
AGENTDECK_REAL_CLAUDE=1 pnpm --filter @agentdeck/mcp-server test real-claude   # 真的 claude -p 连一次（默认跳过）
```
