# @agentdeck/contracts

所有包之间唯一的约定。界面和服务都只认这里的类型，互相不直接引用。

## 文件和负责的线

| 文件 | 内容 | 谁实现 | 谁调用 |
| --- | --- | --- | --- |
| common.ts | ID、尺寸、错误 | — | 所有包 |
| project.ts | ProjectService | 线 3 · workspace-service | 线 2 白板（Add project…、Projects ▾） |
| workspace.ts | WorkspaceService | 线 3 · workspace-service | 线 2 白板（工作区框） |
| git.ts | GitService | 线 3 · git-service | 线 3 源代码管理面板、workspace-service |
| terminal.ts | TerminalHost | 线 1 · tmux-host | 线 1 终端窗口、线 4 agent-adapters |
| agent.ts | AgentService、AgentAdapter、钩子协议 | 线 4 · agent-adapters | 线 2 白板（New terminal ▸）、线 1 终端窗口 |
| status.ts | StatusService、ApprovalService | 线 4 · agent-adapters | 线 1 终端标题栏、线 2 框和顶栏、线 3 面板刷新 |
| board.ts | BoardStore、窗口注册表 | M0 · store；线 2 · canvas | 线 2、各窗口 |
| browser.ts | BrowserService | 线 5 · 主进程 browser 模块 | 线 5 网页窗口 |
| usage.ts | UsageService（终端的 token 用量，插件 PL2） | 线 4 · agent-adapters 的 usage 模块 | 终端窗口上的用量条 |
| skills.ts | SkillsService（终端的 Skills · MCP，N9）和选择的规则 | 线 4 · agent-adapters 的 skills 模块 | 源代码管理面板的 SKILLS · MCP 小节 |
| subagents.ts | SubagentService（agent 自带的后台子 agent，N10，只读） | 线 4 · agent-adapters 的 subagents 模块 | 终端窗口底边的小提示、侧边栏、记录窗口 |
| history.ts | HistoryService（各 agent 的历史会话，N11，只读） | 线 4 · agent-adapters 的 history 模块 | 左边栏（ui/panels/history） |
| launch.ts | 启动预设 LaunchPreset、命令里的密码（findInlineSecret、redactCommand，LA0） | 纯类型和纯函数 | New terminal ▸、Custom command…、mcp-server 的 list_terminals |
| session.ts | SessionService（AgentDeck 自己的 Session、父子、交接，M9 · SE0） | apps/desktop 主进程（SE2）、packages/store（SE1） | 白板标题栏标签、左边栏、Hand off to ▸ |
| capabilities.ts | agent 能力报告（AH0）和由它推出旧的 AgentCapabilities、AutoApproveSupport 的纯函数 | 线 4 · agent-adapters 算报告 | Settings › Agents、菜单 hint、New crew 下拉 |
| limits.ts | LimitService（按账号的额度上限、被打断的终端、续跑，插件 Auto-resume · PL4） | 线 4 · agent-adapters 的 limits 模块（PL5） | 收件箱、终端书签、集群调度器（CR8） |
| crew.ts | CrewService（Agent 集群，模板和自由模式、任务表、关卡、子 session 表、Decisions，CR0） | packages/crew-service（调度器） | 集群框、收件箱、mcp-server 的 /cli |
| inbox.ts | 收件箱的一条 InboxItem（CR0 定形状，服务见 CR1） | 收件箱服务（CR1） | 顶栏 Needs you、⌘J |
| cli.ts | agentdeck 命令行的线路（CliRequest / CliResponse、TERMINAL_KEY_ENV、API_ENDPOINT_FILE）和谁能用哪组命令（cliCommandAllowed，CR13） | mcp-server 的 /cli（CR14） | tools/agentdeck-cli（CR15） |
| app.ts | AppService、Settings | 组装（apps/desktop） | 所有界面 |
| ipc.ts | AgentDeckApi、事件总表、线路约定 | M0 · F3 IPC 层 | 所有界面 |

## 规则

- 这里只放类型和极少量纯函数（错误类、常量），不放实现，不依赖任何第三方包，也不依赖 React、Electron。
- 并发开发期间只允许**加**：新方法、新的可选字段、新事件。不改已有字段的含义，不删东西。
- 改动单独提一个只改 contracts 的提交，同时把 `CONTRACTS_VERSION` 的最后一位加一，合进 main 后其他线再 rebase。
- 必须改已有形状时，先停下来，在任务说明里写清楚要改什么、影响哪几条线，由集成负责人决定。
- 界面上出现的文字（message、label、summary）一律英文。注释和文档用中文。
- `pnpm --filter @agentdeck/contracts typecheck` 必须通过。纯函数的单元测试放 `test/`（只有这里能 import vitest），根目录 `pnpm test` 会跑。`src/typetest.check.ts` 只用于类型检查，随接口一起更新。
