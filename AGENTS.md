# AgentDeck

多 agent、多项目、多分支并行开发的桌面工作台：白板上放真实的 TUI 终端（claude、codex……），每个工作区框对应一个 worktree 和分支，右侧是源代码管理面板，终端里的 localhost 链接直接在白板上打开。

## 先读这些

- 需求（设计画布，带配图和操作流程，以它为准）：https://claude.ai/artifact/2GtB5izXeQSV3NecUYuLAo ，仓库副本 `docs/design/canvas/`（各设计文档的副本和同步说明见 `docs/design/README.md`）
- 组件库（设计系统：tokens、每个界面零件的样子、状态、尺寸、交互规则和代码位置，预览直接用仓库里的 CSS）：https://claude.ai/artifact/MhtbtWuttcdQ4b7uEjvbPN ，仓库副本 `docs/design/components/`，文字版 `docs/components.md`（两边内容一致）。画新界面、画需求配图、做插件前先查它，已有的零件不要重画；改了 `packages/design-tokens` 或 `packages/ui/**` 的样子，同步更新它。
- 插件（Auto-approve、Usage 用量记录）：**做插件前先读 `docs/plugins.md`（插件手册：能贴在哪些东西上、登记表、决定记录）**；样子在设计画布的“插件能力”页，任务是 MVP 任务表的 M7（PL0–PL3）
- 实施方案（技术选型、模块、风险）：https://claude.ai/artifact/QrjHF5gpT6zdHJr6wdFaWp ，本地副本 `docs/design/agentdeck-plan.html`
- MVP 任务表（任务编号、依赖、完成标准）：https://claude.ai/artifact/8UAh7Quj23xxk7oEikgdEg ，本地副本 `docs/design/agentdeck-mvp-plan.html`
- **MVP v2 和 v3（2026-10-24 第一轮验收后定的）**：需求在设计画布的“MVP v2 · v3”那一页（画板 11 · MVP v2、12 · MVP v3、13 · 后台 agent、14 · 左边栏历史会话、15 · 项目框排版，带概念图）；任务在 MVP 任务表的 M5（V1–V5，MVP v2）和 M6（N1–N12，MVP v3）；对应的问题是 IS-51～IS-60，要先调研的是 DR-52～DR-55；v2 的分波和每条线的范围见 MVP 任务表的“MVP v2 实施安排”，验收用例是 TC-29～TC-33。v2 做完之前不开 v3。MVP 是分版本做的：M0–M4 是 MVP v1。
- **Agent 集群（M8，2026-10-27 定）**：按模板组一队 agent 做复杂任务，需求在设计画布“Agent 集群”那一页（画板 C0–C5），任务在 MVP 任务表的 M8（CR0–CR9），问题 IS-89、IS-90，调研 DR-64、DR-65，已定的几条在 `docs/decisions.md`。第一期是 CR0–CR6，CR0（contracts）先做。
- 已定的决策（平台、tmux、环境变量等）：`docs/decisions.md`
- MVP 验收报告（现状、验收证据、端到端用例、问题清单）：https://claude.ai/artifact/FfnyWBeBAg1oPtyHieMbuu ，本地 `docs/status/index.html`（由 `docs/status/build.py` 生成）
- 调研记录（实现中和最初设想不一样的地方、怎么决定的、好处和代价）：`docs/research-log.md`，网页版 https://claude.ai/artifact/M9eSh1RhsiZhP9FCPbmnwK 。各条线发现新的情况写进自己的汇报或 CONTRACT_NOTES.md，合并时由集成负责人加进 `docs/research/entries.py`，不要各自直接改它（避免并行冲突）。
- 接口：`packages/contracts`，规则见 `packages/contracts/AGENTS.md`
- 写插件：步骤见 `.claude/skills/agentdeck-plugin/SKILL.md`（给 agent 和外部贡献者看的，英文），规则和登记表见 `docs/plugins.md`；对外的贡献说明是 `CONTRIBUTING.md`。

## 编号规则

全项目统一，写文档、提交说明、汇报时都用这几种：

- `F1`、`T2`、`X3` 等：MVP 任务表的任务（分支名、提交信息里用）。插件任务用 `PL0`–`PL2`（不用 `P` 开头，免得和问题的 P 级混）。
- `TC-xx`：端到端用例。`TC-01`–`TC-14` 就是设计画布「10 · 全局规则」的 14 条验收场景，`TC-15` 起是补充的。
- `IS-xx`：问题清单里的问题，按登记顺序编号，轻重看 P 级（P0–P3）。
- `DR-xx`：调研记录（`docs/research-log.md`）。
- 用例和问题的唯一来源是 `docs/status/tracking.py`，调研记录是 `docs/research/entries.py`，MVP 现状是 `docs/status/data.py`；改完运行 `python3 docs/status/build.py`（验收报告网页）。用户在网页上填的验收结果和处理状态存在网页的数据库里（集合 acceptance、issues），读写用 ArtifactData。2026-10-24 之前的旧编号（E01、Q38、A1 这类）只在各表的“旧编号”列里保留。

## 技术栈

Electron + TypeScript + React 18 + Zustand，白板用 React Flow（@xyflow/react），终端进程由 AgentDeck 自己的 tmux 实例托管（`tmux -L agentdeck`），界面用 xterm.js 显示，Git 直接调系统 git，本地数据 SQLite，测试 Vitest + Playwright。pnpm 单仓多包。

## 规矩

- 只改你的任务负责的目录。要改 `packages/contracts` 先停下，单独提交，见它的 AGENTS.md。
- 界面依赖方向：`packages/ui/*` 只能依赖 contracts 和 design-tokens；服务不能依赖 ui；各 widget、各 adapter 之间不互相引用。机器检查的完整规则见下面「检查和模块边界」。
- 产品界面上的所有文字用英文；注释、文档、提交说明里的解释用中文也可以。
- 组件里不写颜色值，样子只在 `packages/design-tokens` 里定。界面风格：暖灰加墨黑；颜色只表达状态（MVP v2 · V2 红绿灯）：运行中绿（`--status-running`）、等你黄（`--status-waiting` / `--attention`）、出错红（`--status-error`）；插件 Auto-approve 开着时的书签用红色（`--plugin-auto-approve`）；每种 code agent 有一个身份色（`--agent-claude` `--agent-codex` `--agent-pi` `--agent-omp` `--agent-kimi`，2026-10-26 定），只用在区分 agent 的小标记上（左边栏历史会话的 agent 小标题），别处不用彩色；不用渐变、发光、emoji。
- 分支名和提交信息带任务编号，例如 `feat/F6-fakes`、`F6: add fake TerminalHost`。
- 提交前：`pnpm check`（含所有包的测试）。
- 每个包有自己的 AGENTS.md：职责、对外接口、不许碰的目录、怎么跑测试。新建包时一起写。

## 检查和模块边界

`pnpm check` = `pnpm typecheck`（`pnpm -r typecheck`）+ `pnpm lint`（ESLint）+ `pnpm colors`（CSS 里的颜色值）+ `pnpm boundaries`（dependency-cruiser）+ `pnpm test`（Vitest，跑所有包的测试）。CI（`.github/workflows/check.yml`）在 macOS 和 Ubuntu 上跑 `pnpm install --frozen-lockfile && pnpm check`。

- 配置都在根目录，各包不要再放自己的：`eslint.config.js`、`.dependency-cruiser.cjs`、`vitest.config.ts`、`.prettierrc.json`。
- `pnpm test` 把 `pnpm-workspace.yaml` 里每个有 package.json 的包当作一个 Vitest project；包里有自己的 `vitest.config.*` 就用它（界面包要 jsdom 时自己写一个）。单跑一个包：`pnpm --filter <包名> test`。
- 端到端测试（R2）：`pnpm e2e`，Playwright 的 Electron 模式驱动真应用，要 tmux；不在 `pnpm check` 里，CI 是单独的 `.github/workflows/e2e.yml`。改了界面或组装后跑一遍。跑法、隔离和假 agent 见 `e2e/AGENTS.md`。
- Prettier 是可选的：`pnpm format` / `pnpm format:check`，不在 `pnpm check` 里（contracts 目前没按它排版）。
- `pnpm boundaries` 直接调 dependency-cruiser 的 API（`scripts/boundaries.mjs`），因为 `depcruise` 命令行拒绝在 node 25 上跑。

### 模块边界（`.dependency-cruiser.cjs`）

规则按路径写，`import type` 也算依赖。每条规则在 `tools/boundary-fixtures/cases/<规则名>/` 有一个故意违规的样例，`cases/allowed/` 是所有允许的写法，`pnpm test` 断言前者被拦、后者不拦。改规则时同步改样例。

| 规则 | 内容 |
| --- | --- |
| `contracts-standalone` | `packages/contracts` 不依赖任何其他内部包、第三方包、node 内置模块（`packages/contracts/test/` 下的纯函数单元测试可以用 vitest） |
| `ui-allowed-deps` / `ui-widget-panel-allowed-deps` | `packages/ui/**` 只能依赖 contracts、design-tokens、`ui/kit`、`ui/canvas` 的注册表和自己包里的文件（第三方包如 react 可以） |
| `ui-canvas-allowed-deps` | `ui/canvas`（白板）在上一条之外还能用 `ui/window-shell` 和 `ui/topbar`；这两个包只管外观，不反过来依赖 canvas |
| `no-widget-to-widget` / `no-panel-to-panel` | `ui/widgets/*` 之间、`ui/panels/*` 之间不互相 import |
| `ui-no-services` | 界面不 import 服务包，走 `window.agentdeck` |
| `ui-no-electron` / `ui-no-node-builtins` | 界面不 import electron 和 node 内置模块（vite / vitest / playwright 的构建配置可以用 node 内置模块） |
| `service-no-ui` | 服务包（tmux-host、git-service、workspace-service、agent-adapters、port-watch、store、mcp-server）不依赖 `packages/ui/**` |
| `service-to-service` / `workspace-service-only-git-service` | 服务包之间不互相 import，只有 workspace-service → git-service 可以 |
| `fakes-only-contracts` | `tools/fakes` 在内部只依赖 contracts（第三方包和 node 内置模块可以） |
| `fakes-only-in-tests-and-dev` | 只有测试文件和 dev 入口能 import `tools/fakes` |
| `only-desktop-uses-services` / `only-desktop-uses-ui` | 只有 `apps/desktop` 能用服务包、能把界面装起来，也就是只有它把两边接在一起 |

几个约定，写代码时照着做规则才认：

- canvas 的注册表放在 `packages/ui/canvas/src/registry.ts`（或 `src/registry/` 目录），package.json 用子路径导出，例如 `"./registry": "./src/registry.ts"`。canvas 其他文件对别的界面包不开放。
- 测试文件：`*.test.ts(x)`、`*.spec.ts(x)`、`__tests__/`、`test/`、`tests/`、`e2e/` 下的文件、`*.setup.ts`、`vitest.config.*`、`playwright.config.*`。dev 入口：`dev/` 目录下的文件或 `*.dev.ts(x)`。
- `packages/ui/widgets/*`、`packages/ui/panels/*` 已加进 `pnpm-workspace.yaml`，每个 widget/panel 是一个独立的包。
- 需要放宽规则（比如 canvas 要用 window-shell）时，改 `.dependency-cruiser.cjs` 和对应样例，单独提交并在提交说明里写原因。

### 界面里不写颜色值

- `.ts` / `.tsx`：ESLint 规则（根目录 `eslint.config.js` 的 `no-restricted-syntax`），作用于 `packages/ui/**`，拦十六进制颜色和 `rgb()` `hsl()` `hwb()` `lab()` `lch()` `oklab()` `oklch()`。只看字符串和模板字符串，注释不算。确实要写时：`// eslint-disable-next-line no-restricted-syntax -- 原因`。像 `'#123'` 这样的字符串会被当成颜色，同样用这个注释放行。
- `.css`：用 F4 的 `packages/design-tokens/lint/raw-colors.mjs`（命令行，放行写 `raw-color-ok`）。它同时提供 ESLint 插件 `agentdeck/no-raw-colors`，**不接进 ESLint**，避免同一处报两次；两边的正则保持一致。已接进 `pnpm check`（`pnpm colors`）。
