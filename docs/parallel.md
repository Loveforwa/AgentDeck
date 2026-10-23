# 并发开发安排

接口已经定在 `packages/contracts`（0.1.0）。之后分三波：先并发补齐地基，再 5 条线并发做功能，最后组装。
任务编号对应《AgentDeck MVP 实施计划》表（docs/design/agentdeck-mvp-plan.html）。

## 第 0 波 · 已完成

- F2 contracts 第一版：项目、工作区、Git、终端、agent 和钩子协议、状态和批准、白板、网页、应用外壳、IPC 总表。
- F1 的一部分：pnpm 单仓、tsconfig、contracts 包。

## 第 1 波 · 地基，6 个 agent 同时做（约 1–2 天）

彼此不依赖，只依赖 contracts。

| 任务 | 目录 | 交付 |
| --- | --- | --- |
| F3 IPC 层和应用空壳 | apps/desktop | electron-vite 空窗口；preload 暴露 `window.agentdeck`；按 ipc.ts 的线路约定路由；终端输出的 MessagePort |
| F4 tokens 和基础零件 | packages/design-tokens、packages/ui/kit | tokens.css；Button、Menu、Dialog、Toast、Popover；演示页 |
| F5 CI 和边界 | 根目录 | `pnpm check`：类型检查、ESLint（禁写死颜色）、dependency-cruiser、Vitest |
| F6 假实现 | tools/fakes | contracts 里**每个服务**的内存假实现；假 tmux 能回放录好的输出；临时 git 仓库生成器 |
| F7 tmux 试验 | packages/tmux-host（只放配置和结论） | agentdeck 用的 tmux.conf；按键、滚动、颜色、attach 速度的结论 |
| F8 本地存储 | packages/store | BoardStore 的 SQLite 实现和迁移；项目、工作区、终端记录表 |

F6 最先需要：第 2 波每条线都靠它脱离别人独立运行。可以让 F6 先交一版只有 TerminalHost 和 GitService 的，再补其他。

## 第 2 波 · 5 条线同时做（约 1–2 周）

每条线一个 worktree、一个分支，只改自己的目录；依赖别的线时用 tools/fakes 里的假实现。

| 线 | 任务 | 实现的接口 | 目录 |
| --- | --- | --- | --- |
| 1 终端 | T1 T2 T3 T5 T6 T7 T8 | TerminalHost | packages/tmux-host、packages/port-watch、packages/ui/widgets/terminal |
| 2 白板 | B1–B5 W3 W5 S3 R1 | BoardStore 的使用方、窗口注册表 | packages/ui/canvas、packages/ui/window-shell、packages/ui/topbar |
| 3 工作区和 Git | W1 W2 W4 G1–G4 | ProjectService、WorkspaceService、GitService | packages/workspace-service、packages/git-service、packages/ui/panels/scm |
| 4 Agent 和状态 | T4 S1 S2 S4 | AgentService、StatusService、钩子协议 | packages/agent-adapters、tools/agentdeck-notify |
| 5 网页 | U1 U2 U3 | BrowserService | packages/ui/widgets/browser、apps/desktop/src/main/browser |

### 线和线之间的接缝

这些地方两边都按 contracts 写，组装时直接接上，开发时各自用假数据：

- 终端 activity / silence / exit 事件 → 线 4 的状态机。
- 线 4 的 `agent.turn-end` → 线 3 的面板刷新。
- 终端 `terminal.link`（localhost）→ 线 5 在同一个框里开网页窗口；打开动作由线 2 的白板执行。
- 线 3 `workspaces.create` 返回的 `setup` → 线 2 在框里开一个 Shell。
- 线 2 的 New terminal ▸ → 线 4 的 `agents.start`，返回的 terminalId 交给线 1 的终端窗口。
- `status.changed` → 线 1 标题栏、线 2 框和顶栏。

## 第 3 波 · 组装（1 个 agent + 1 个审查）

- apps/desktop 把真实实现接到 IPC 上，替换假实现。
- R2：把「10 · 全局规则」的验收场景写成 Playwright 用例。
- 合并顺序：contracts → 服务（线 1、3、4、5 的服务部分）→ 界面（线 2，再各个窗口）。

## M4（P1）同样按线并发

| 线 | 任务 |
| --- | --- |
| 1 | X5 关窗口后台继续、X6 恢复上次会话 |
| 2 | X10 多选和撤销 |
| 3 | X7 没有 git 的文件夹、X8 差异、X9 提交记录 |
| 4 | X1 codex 钩子、X2 等你文字、X3 Approve all、X4 Fork |
| 5 | X11 需要登录的网页 |

## 每条线的规矩

1. 只改自己的目录。要改 contracts 先停，见 packages/contracts/AGENTS.md。
2. 分支名带任务编号，例如 `feat/T2-terminal-view`。
3. 提交前跑 `pnpm check` 和本包测试。
4. 每个包更新自己的 AGENTS.md：职责、对外接口、怎么跑测试。
