# AgentDeck

多 agent、多项目、多分支并行开发的桌面工作台：白板上放真实的 TUI 终端（claude、codex……），每个工作区框对应一个 worktree 和分支，右侧是源代码管理面板，终端里的 localhost 链接直接在白板上打开。

## 先读这些

- 需求（设计画布，带配图和操作流程，以它为准）：https://claude.ai/artifact/2GtB5izXeQSV3NecUYuLAo
- 实施方案（技术选型、模块、风险）：https://claude.ai/artifact/QrjHF5gpT6zdHJr6wdFaWp ，本地副本 `docs/design/agentdeck-plan.html`
- MVP 任务表（任务编号、依赖、完成标准）：https://claude.ai/artifact/8UAh7Quj23xxk7oEikgdEg ，本地副本 `docs/design/agentdeck-mvp-plan.html`
- 并发安排：`docs/parallel.md`
- 接口：`packages/contracts`，规则见 `packages/contracts/AGENTS.md`
- `docs/design/agentdeck-mvp-spec.html` 是早期版本，已不维护。

## 技术栈

Electron + TypeScript + React 18 + Zustand，白板用 React Flow（@xyflow/react），终端进程由 AgentDeck 自己的 tmux 实例托管（`tmux -L agentdeck`），界面用 xterm.js 显示，Git 直接调系统 git，本地数据 SQLite，测试 Vitest + Playwright。pnpm 单仓多包。

## 规矩

- 只改你的任务负责的目录。要改 `packages/contracts` 先停下，单独提交，见它的 AGENTS.md。
- 界面依赖方向：`packages/ui/*` 只能依赖 contracts 和 design-tokens；服务不能依赖 ui；各 widget、各 adapter 之间不互相引用。
- 产品界面上的所有文字用英文；注释、文档、提交说明里的解释用中文也可以。
- 组件里不写颜色值，样子只在 `packages/design-tokens` 里定。界面风格：暖灰加墨黑，只有“需要你处理”用橙色；不用渐变、发光、emoji。
- 分支名和提交信息带任务编号，例如 `feat/F6-fakes`、`F6: add fake TerminalHost`。
- 提交前：`pnpm -r typecheck`（F5 完成后改为 `pnpm check`）和本包测试。
- 每个包有自己的 AGENTS.md：职责、对外接口、不许碰的目录、怎么跑测试。新建包时一起写。
