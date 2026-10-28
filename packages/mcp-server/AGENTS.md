# @agentdeck/mcp-server

AgentDeck 自己的 MCP 服务（任务 M1）。白板里的 agent 通过它开终端、开工作区、开网页、看和指挥别的终端。只在**主进程**里用。

- HTTP（streamable HTTP，无状态），只听 `127.0.0.1`，固定端口 `47621`，被占用时换随机端口。
- 用到的服务（projects、workspaces、agents、terminals、status）和白板事件出口都由构造参数注入，类型来自 contracts，不 import 别的服务包。
- 挂到 agent 上：`packages/agent-adapters`（`LaunchContext.mcp`）。claude `--mcp-config`，codex `-c mcp_servers.agentdeck.*`，omp `--plugin-dir`（N1）；pi、kimi 启动时挂不上，原因见 agent-adapters/AGENTS.md。
- initialize 带 `SERVER_INSTRUCTIONS`（什么时候该用这些工具，claude 会放进系统提示）。需求里的“自动装载一个 AgentDeck skill”先用它代替，不往用户配置里写 skill。
  CR14（IS-100）缩到两句（约 80 token）：只说什么时候去找这些工具，每个工具怎么用写在工具自己的说明里。
- 同一个端口上还有 agentdeck 命令行的 `POST /cli`（CR14，见下面「命令行 /cli」）。工具实现只有一份（`src/tools.ts` 的 `TOOLS`），
  MCP 用 `registerTools` 注册，命令行用 `callTool` 直接调。

不许碰：`packages/contracts`（不够用先停下，见它的 AGENTS.md）、其他包。

## 工具

工具名、参数、返回文字都是英文。返回值是 JSON 文本；服务抛的错变成 `isError` 加一句英文。

| 工具 | 做什么 | 默认 |
| --- | --- | --- |
| `list_workspaces` | 项目和工作区，调用者所在的工作区标 `current` | |
| `list_terminals` | 终端和状态（含在等什么），调用者自己标 `self`；可按工作区过滤；不列隐藏的终端，`command` 里写明的密码换成 `***`（AH11） | |
| `open_terminal` | `agents.start` 开 agent 或 Shell，再让白板把窗口放进框里；可带第一条消息 `prompt` | 调用者的工作区，agent 为 claude |
| `create_workspace` | `workspaces.create` 新建 worktree 和分支 → 框放上白板 → 有初始化命令先开 Shell 跑 → 开 agent（带 `prompt`） | 调用者的项目，agent 为 claude，`none` 不开 |
| `open_browser` | 白板开网页窗口，放在调用者终端旁边（`nearTerminal`）；同一个 origin 复用已开的窗口（跳过去刷新）。只收 http(s) 和本地文件，见下 | 调用者的工作区 |
| `read_terminal` | 别的终端最后 n 行（最多 500）；隐藏的终端拒绝（AH11） | 60 行 |
| `send_to_terminal` | 往别的终端打字，再按回车；不能发给自己；目标在等你（needs-approval、needs-reply）时拒绝（AH7）、隐藏的终端拒绝（AH11），见下 | `submit: true` |
| `open_terminals`（N1） | 一次开 `count` 个 agent（每个子 agent 一个，`prompts[i]`、`labels[i]` 依次给），发一个 `board.open-group`：白板把它们挂在调用者旁边，组成窗口组。超过 6 个先 `confirm` 问用户，没有 `confirm` 或用户拒绝就一个都不开；最多 16。一个一个开，中途失败时已开的照样放上白板，返回里 `error` 写停在第几个 | 调用者的工作区，agent 为 claude |
| `list_windows`（N1） | 白板上的窗口：类型、标题、工作区、终端 id、agent、状态、在等什么、对话主题（`TerminalInfo.title`）、网址、窗口组、`self`。读 `board.load()`，白板改动后半秒才保存，刚开的窗口可能还不在 | |
| `focus_window`（N1） | `window_id` 或 `terminal_id`（二选一，先核对存在）→ `board.focus-window`。白板：跳过去聚焦；用户正在打字时只闪一下 | |
| `notify`（N1） | 一句话（最多 300 字，空白压成一个空格）→ `board.notify`（调用者窗口闪一下 + 白板提示；正在打字时只闪）；再交给 `onNotify`（组装时：应用在后台发系统通知） | |

N1 加的注入项都是可选的：`board`（list_windows 没有它就报错，focus_window 没有它就不核对 window_id）、`confirm`、`onNotify`。
AH11 加 `hiddenFromAgents`（可选）：返回勾了 Hide from agents 的终端 id；组装时用 `hiddenTerminalIds(await board.load())` 从保存的白板算。没有时当作都没隐藏；它抛错时这几个工具报错，不当作没隐藏。list_windows 也不列隐藏的终端窗口。

### open_browser 收什么地址（`browserTarget`）

- `http://`、`https://` 带主机名的，URL 规范化后原样（`http://localhost:5173` → `http://localhost:5173/`）。
- 不带协议的本机地址（`localhost:3000`、`127.0.0.1:8080/app`、`0.0.0.0`、`[::1]`）补上 `http://`：agent 常这么写。
- 本地文件：绝对路径原样；`file://` URL（主机只能空或 localhost）换成绝对路径（`BrowserWindowData.url` 的约定，打开时再经 `BrowserService.prepare`）。
- 其他一律 `Only http(s) URLs and local files can be opened: …`，不发事件：`javascript:`、`data:`、`ftp:`、`chrome:`、相对路径、`~/…`、`//host/…`、`file://别的主机/…`。

“调用者的工作区”：先问注入的 `workspaceOf`（组装时接状态机），再看 `status.snapshot` 的 `workspaceId`，最后按终端当前目录找路径最长的工作区。

## 认证和调用者

- 密钥（token）是 `~/.agentdeck/run/mcp-token`（0600）里的 64 位十六进制数，`loadOrCreateToken` 读或生成；存下来是为了 AgentDeck 重启后，tmux 里还活着的 agent 不用重开。
- `x-agentdeck-terminal: <终端 id>`：调用者是哪个终端。
- **终端钥匙**（CR14，IS-101）：`terminalKey(token, 终端 id)` = HMAC-SHA256，十六进制。agent-adapters 开终端时放进它的环境
  （`AGENTDECK_TERM_KEY`，MCP 配置里的 `${AGENTDECK_MCP_TOKEN}` 也是它），终端里不再有共用的密钥。
  `Authorization: Bearer <钥匙>` 和请求头的终端 id 对上才认；Worker 把终端 id 改成 Lead 的也过不了（401）。
- MCP 这边**共用 token 还收一个版本**：升级前开的终端环境里是它（这时终端 id 只看请求头，和以前一样）。下个版本去掉。`/cli` 只认钥匙。
- claude 的配置里两者都写成环境变量（`${AGENTDECK_MCP_TOKEN}`、`${AGENTDECK_TERM}`），claude 自己展开（2.1.291 实测），所以 token 不出现在命令行上。环境里没有 `AGENTDECK_TERM` 时 claude 原样发 `${AGENTDECK_TERM}`，当成不在 AgentDeck 的终端里。
- 带 `Origin` 的请求（网页）一律 403；`Host` 不是本机的也 403（防 DNS rebinding）。
- 无状态：每个请求新建 McpServer 和 transport，不发 `Mcp-Session-Id`。AgentDeck 重启后只要端口没变，agent 的下一次调用照常能用。

## 命令行 /cli（CR14）

`agentdeck` 命令（`tools/agentdeck-cli`）发 `POST /cli`，body 是 contracts 的 `CliRequest`，回 `CliResponse`（JSON；钥匙不对是 401，body 也是 CliResponse）。
Origin、Host 检查和 MCP 一样。实现在 `src/cli.ts`（`handleCli`，不抛错，测试可以直接调）。

- 地址：`startMcpServer({ apiFile })` 起来后写 `ApiEndpointFile`（`{ v: 1, url: 'http://127.0.0.1:<port>', version }`，先写临时文件再改名，0600），
  关掉时删掉（还是自己写的那份时）。端口变了（47621 被占用换随机端口）跟着写。命令行每次现读，所以 AgentDeck 换了端口还开着的 agent 也能连上。
  组装时放在 `<数据目录>/run/api.json`（默认数据目录下就是 contracts 的 `~/.agentdeck/run/api.json`）。unix socket（`socket` 字段）等 CR12 的实测再定，
  命令行那边已经按 `socket` 分了路（`http.request` 的 `socketPath`）。
- 谁能跑哪条：只看 contracts 的 `cliCommandAllowed`（服务端和 help 用同一份）。认角色要 `crew()`（`CrewService.membership`），认 forge 要
  `sessions()`（调用者 Session 的 origin）。两个都是函数：服务还没组装时返回 null。
- 命令：
  - `open <url>` → 工具 `open_browser`；`notify <message>`（也可以从 stdin）→ 工具 `notify`。和 MCP 调同一个工具结果一样。
  - `help [组]`：这个终端能跑的命令（按 cliCommandAllowed 过滤，服务没有的组不列）。
  - `crew status | diff | check | merge | ask | note | done` → CrewService 同名方法；`plan`、`add` 这些模板模式的命令由 CR3 接上，现在回 not available yet。
  - `session open（= spawn）| list | read | result | send | wait | close`（只有 Lead）→ CrewService。`open` 的提示词从 stdin 读，没给 `--label` 用 agent 名（重了加 -2）。
    `read`、`result`、`send` 先找到目标 Session 的终端，过 `agentTerminalRefusal`（AH7、AH11，和 MCP 同一条判断）；`send` 碰上 busy、waiting-for-user 都算出错。
  - `doc`、`flow`、`lesson`、`run`、`job`、`out`（所有 AgentDeck 终端）和 `forge`（只给 origin 为 forge 的）：路由和放行先有，服务是别的线，回 “<组> is not available yet”。
  - 没有 CrewService 时 crew、session 回 “crew is not available yet” / “session is not available yet”（不说 Not in a crew.）。
- 拒绝时的话（TC-61）：集群外 “Not in a crew.”；Worker 开 session “Only the Lead can open sessions.”，别的 session 命令 “Only the Lead can manage sessions.”，
  改任务表 “Only the Lead can change the plan.”；forge “Only terminals opened from an issue or pull request can run agentdeck forge.”。每次拒绝调 `onCliRefused`（组装时记日志）。
- 集群里不是 Lead 的终端，MCP 的 tools/list 不列 `LEAD_ONLY_TOOLS`（open_terminals、create_workspace、send_to_terminal，DR-72）；集群外、Lead 照旧 11 个。
- `estimateInjection(agent, { omit })`：AgentDeck MCP 每轮大概多带多少 token（字符数 / 4），给 Skills · MCP 那一行（contracts 的 `InjectionEstimate`，id `mcp:built-in:agentdeck`）。
  claude、omp 按延迟加载（instructions + 工具名，claude 约 160），codex 先按预先加载（完整定义，约 2,060；0.164.0 是否延迟待 CR12），pi、kimi 挂不上返回空数组。

## 白板事件

终端、工作区由服务建好后发 contracts 的 `BoardEvent`，白板（`packages/ui/canvas`）放上去：

- `board.add-frame`：工作区放到空位上。
- `board.open-window`：窗口放进框里；`highlight` 时闪一下。不抢键盘焦点、不动视口。`nearTerminal`（N1）：放在这个终端的窗口右边。
- `board.open-group`（N1）：一组终端挂在 `lead`（调用者）旁边，记进窗口组（`WindowNode.group`，随白板保存，N2 的侧边栏读它）。
- `board.focus-window`、`board.notify`（N1）：见上表。

白板没开（窗口都关了）时事件没人收，终端照常在跑，但白板上没有它的窗口。

## agent 能不能碰一个终端（`src/guard.ts`，AH7、AH11）

所有“agent 往别的终端里看、打字”的入口用同一个判断 `agentTerminalRefusal(access, { status, hidden })`（不调服务，只看传进来的状态，从包入口导出）：现在是 send_to_terminal，以后 agentdeck 命令行（CR14 的 /cli）和 Flow 窗口的 Ask <agent> about this step…（CU2）也用它。

- `send`：目标的 `StatusSnapshot.status` 在 contracts 的 `WAITING_STATUSES`（needs-approval、needs-reply）里时拒绝，`invalid-argument`，“This terminal is waiting for the user. Use the inbox.”（2026-10-28 定：不加新错误码）。不然往停在批准提示上的终端打 “1” 加回车就等于替人批准，绕过收件箱、破坏性名单和 ApprovalRecord（IS-102）。
- 文字打出去以后、按回车前再查一次：这 150ms 里目标停下来问你，就不按回车，返回同样的错。
- 先看隐藏（AH11、IS-129）：`hidden` 时 `read`、`send` 都拒绝，“The user hid this terminal from agents”（又隐藏又在等你时也报这句，不透露在等什么）。
- 状态不知道（snapshot 里没有）时不挡。`read` 只挡隐藏的。open_terminal(s) 的 `prompt(s)` 走 `agents.start`，不受影响。

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
  board,                         // N1：BoardStore（list_windows、focus_window）
  confirm: async (q) => …,       // N1：open_terminals 超过 6 个时问用户，返回 true 才开
  onNotify: (n) => …,            // N1：notify 工具，应用在后台时发系统通知
  apiFile: '<数据目录>/run/api.json', // CR14：命令行找服务的地址
  crew: () => …,                 // CR14：CrewService，还没组装时 null
  sessions: () => …,             // CR14：SessionService，还没组装时 null
  onCliRefused: (r) => …,        // CR14：拒绝的命令记日志
});
// agent-adapters：createAgentRuntime({ …, mcp: () => mcp.endpoint })
// 退出前：await mcp.close()
```

## 测试

```bash
pnpm --filter @agentdeck/mcp-server test        # 真的 HTTP + SDK 的 Client，后面是 tools/fakes（cli.test.ts：/cli、钥匙、角色、api.json）
pnpm --filter @agentdeck/mcp-server typecheck
AGENTDECK_REAL_CLAUDE=1 pnpm --filter @agentdeck/mcp-server test real-claude   # 真的 claude -p 连一次（默认跳过）
AGENTDECK_REAL_CODEX=1 pnpm --filter @agentdeck/mcp-server test real-codex     # 真的 codex app-server 连一次（默认跳过）
```

real-codex（N1，2026-10-25 codex 0.164.0 跑过）：照 agent-adapters 的 `codexMcpOverrides` 用 `-c` 挂上，起 `codex app-server`（临时 `CODEX_HOME`，不碰 `~/.codex`），
`mcpServerStatus/list` 列出了 agentdeck 和全部工具（token 从 `bearer_token_env_var` 取对了），`thread/start` 建一个空会话（不发消息、不连模型）后
`mcpServer/tool/call` 调 `list_workspaces`，feat/login 标了 `current`（`x-agentdeck-terminal` 从 `env_http_headers` 取对了）。
