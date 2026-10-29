# @agentdeck/store

AgentDeck 的本地数据，SQLite（better-sqlite3）。实现 contracts 的 `BoardStore`，另外给主进程里的服务提供项目、工作区、终端恢复信息、批准记录、Session（SE1）五个仓储。

只在**主进程**里用。界面拿数据走 IPC 和各个服务，不直接引用本包。

## 对外接口

```ts
import { openStore } from '@agentdeck/store';

const store = openStore(join(homedir(), '.agentdeck', 'agentdeck.db')); // 路径由调用方给，测试用 ':memory:'
store.board        // BoardStore（contracts），异步
store.projects     // ProjectRepository
store.workspaces   // WorkspaceRepository
store.terminals    // TerminalRepository
store.approvals    // ApprovalRepository
store.sessions     // SessionRepository（M9 · SE1；服务在 apps/desktop/src/main/sessions.ts）
store.docAnchors   // DocAnchorRepository（M15 · DC2；用的人是 doc-service 的 CodeAnchorService，由 apps/desktop 注入）
store.transaction(() => { ... }) // 几步写入放进一个事务，抛错全部回滚；可以嵌套
store.close()
```

- 仓储的类型在 `src/types.ts`，不在 contracts：它们只在主进程里用，不过 IPC。
- 仓储是**同步**的（better-sqlite3 本身同步，同步才能放进 `transaction`）。服务对外是异步接口，自己包一层即可。
- `put` 都是“有就整条更新、没有就插入”（`ON CONFLICT DO UPDATE`，不会触发级联删除）。部分字段的合并（比如 `ProjectPatch`）由服务先 `get` 再 `put`。
- `openStore` 打开时自动跑迁移；文件所在的文件夹不存在会建出来。打开失败（比如数据库来自更新版本的应用）抛 `AgentDeckError`，code 为 `unsupported`。

## 表结构（迁移 1、2、3）

| 表 | 主键 | 内容 |
| --- | --- | --- |
| `schema_version` | version | 已跑过的迁移：version、name、applied_at |
| `board` | id（只能是 1） | `state`：整份 `BoardState` 的 JSON；`saved_at` |
| `projects` | id | `Project`；`path` 唯一；`repos`、`copy_into_worktrees` 是 JSON；`missing` 0/1；索引 `last_used_at DESC` |
| `workspaces` | id | `Workspace`；`project_id` → projects（级联删除）；`repos` 是 JSON；每个项目最多一个 `mode = 'main-folder'`（部分唯一索引） |
| `terminals` | terminal_id | 恢复信息：window_id（唯一，可空）、workspace_id → workspaces（级联删除，可空）、agent、cmd、args（JSON）、cwd、agent_session_id（agent 自己的会话 id，迁移 1 里叫 session_id）、session_id → sessions（迁移 2，SessionId，删 Session 时置空）、start_command、last_status、exit_code、updated_at |
| `sessions` | id | 迁移 2 · `Session`：agent、workspace_id → workspaces（**删工作区时置空**，Session 留着当散放的）、cwd、parent_id → sessions（删父时置空）、origin（JSON `SessionOrigin`）、label、title、terminal_id（停了为空，不加外键）、state、handed_off_to → sessions、handoff_note、created_at、updated_at；索引 `(parent_id, created_at)`、`created_at DESC`、terminal_id |
| `doc_anchor_cache` | (doc_path, ref_key, baseline, target_hash) | 迁移 3 · 文档里代码引用上次的核对结果：doc_path 是文档的绝对路径（每个 worktree 一份）、ref_key（路径、起止行、符号、钉住的版本）、baseline（`pinned:` / `verified:` / `blame:` / `worktree`）、target_hash（工作区里被引用文件的 sha1）、result（doc-service 的 JSON，本包不解析）、checked_at。每篇整篇替换（`replaceCache`） |
| `doc_anchor_verified` | (doc_path, ref_key) | 迁移 3 · Mark as checked 的记录：path、start_line、end_line（核对时那个版本里的位置）、blob → doc_anchor_blobs、lines_hash（这几行原文的 sha1）、verified_at |
| `doc_anchor_blobs` | blob | 迁移 3 · 核对时被引用文件的全文（blob 是 git 的 blob id）。`putVerified` 顺手删掉没有记录再用到的 |
| `session_agent_ids` | (session_id, seq) | 迁移 2 · `Session.agentSessions` 的每一段：session_id → sessions（级联删除）、seq 从 1 起、agent_session_id（有索引，`findByAgentSession` 用）、started_at、reason |
| `approval_history` | seq（自增） | `ApprovalRecord` 拆成列：request_id、terminal_id、workspace_id → workspaces（级联删除）、agent、kind、summary、command、destructive、requested_at、by、at；索引 `(workspace_id, at DESC)` |

几个约定：

- 删项目 → 它的工作区 → 工作区的终端记录和批准记录，一路级联删掉。散放终端（workspace_id 为空）不受影响。
- 同一个窗口重启后恢复会拿到新的 terminalId：`terminals.put` 会把这个窗口原来那条记录替换掉。窗口关了、终端还在后台跑时 window_id 为空，可以有多条。
- 枚举类的列（kind、mode、agent、last_status、by）没加 CHECK：SQLite 改 CHECK 要重建表，而 contracts 允许往枚举里加值。类型由 TypeScript 保证。
- 时间都是 ISO 字符串，排序直接按字符串比。
- `TerminalRecord.sessionId` 是 agent 自己的会话 id（列 agent_session_id），`TerminalRecord.session` 是 AgentDeck 的 SessionId（列 session_id），和 `TerminalWindowData` 的两个字段同名。
- IS-95：`terminals.prune(keep)` 只留 tmux 里还在的终端，主进程在启动时拿到 `TerminalHost.list()` 后调一次；拿不到列表时不调。
- Session（SE1）：`sessions.put` 整条写（连同分段）；`updateState` 只改 state、terminalId、handedOffTo（state 不是 handed-off 时清掉 handedOffTo）；`addSegment` 在最后加一段。`list` 新的在前，`listByParent` 按先后。
- 迁移 2 的升级（TC-55）：白板上每个还没有 `data.session` 的终端窗口补一条 Session 并写回白板；`WindowNode.group` 里 member 的 parentId 是同组 lead 的那条（origin `spawn · open_terminals`，label 取 group.label，没有再取窗口的 Rename），group 本身留着给 N2 侧边栏；有 terminalId 的记 running（应用启动时对不上 tmux 的由 SE2 改 stopped），没有的 stopped；窗口记着的 agent 会话 id 记成第一段（reason unknown）；对应的 terminals 记录填上 session_id。白板读不出来时跳过，不让迁移失败。
- 空库 `board.load()` 返回空白板：viewport 0,0,1；panel open、width 320；`savedAt` 为 `NEVER_SAVED`（1970-01-01）。
- `board.save` 先删再插，在一个事务里；中途失败回到原来那份。`version` 不是 1 时抛 `invalid-argument`。

## 改表结构

1. 在 `src/migrations.ts` 的 `migrations` 末尾追加 `{ version: N + 1, name, up(db) }`。**已经发布的迁移不再改。**
2. 每个迁移单独一个事务，失败整步回滚。跑迁移期间外键检查是关的（方便“建新表、拷数据、删旧表、改名”这种重建），跑完用 `foreign_key_check` 整体查一遍，有断掉的引用就回滚。
3. 在 `test/migrations.test.ts` 加一条：旧版本的库升级后数据还在。
4. `BoardState` 的形状如果将来升到 version 2，在这里加一个迁移把 `board.state` 的 JSON 改写掉。

## 原生模块和 Electron（组装阶段要做的事）

better-sqlite3 是原生模块。现在用的 13.x 走 **N-API**（node-addon-api），包里自带各平台的预编译文件（`prebuilds/<平台>-<架构>.node`），没有 install 脚本，加载时按 `process.platform/arch` 直接挑。N-API 跨 Node / Electron 版本 ABI 稳定，所以：

- **不需要** electron-rebuild。（如果哪天退回 12.x 或更老的版本，那是按 Node ABI 编的，必须 `electron-rebuild -f -w better-sqlite3`，或者在 electron-builder 里开 `npmRebuild`。）
- electron-vite：主进程里 better-sqlite3 必须**外部化**，不能打进 bundle（它用 `require('../prebuilds/xxx.node')` 动态加载）。用 `externalizeDepsPlugin()`，或者在 `main.build.rollupOptions.external` 里加 `'better-sqlite3'`。`@agentdeck/store` 本身是 TS 源码，要打进 bundle（不要外部化它）。
- 打包（electron-builder）：`.node` 不能放在 asar 里，加 `asarUnpack: ['**/node_modules/better-sqlite3/**']`；只打目标平台的 prebuild 即可。
- pnpm 10 安装时会提示 “Ignored build scripts: better-sqlite3”（因为包里有 binding.gyp）。**不用批准**：批准后会去跑 node-gyp 从源码编译，白白多花时间，预编译文件已经够用。想消掉提示，在根目录 `pnpm-workspace.yaml` 里加 `ignoredBuiltDependencies: [better-sqlite3]`（根目录归 F5 / 组装管）。
- 还没在 Electron 里实际跑过，组装时开一次应用确认 `openStore` 能打开库。

## 测试

```bash
pnpm --filter @agentdeck/store test       # Vitest，在 Node 里跑，用 :memory: 和临时文件
pnpm --filter @agentdeck/store typecheck
```

- `test/migrations.test.ts`：空库建表、重复执行不变、升级保留数据、失败回滚、断外键回滚、拒绝新版本的库、迁移序号不连续；迁移 2 把旧白板的终端窗口和窗口组变成 Session 和父子关系（TC-55 的后台部分）。
- `test/board.test.ts`：空库加载、往返、整份替换、中途失败回滚、拒绝未知版本、关闭重开。
- `test/doc-anchors.test.ts`：核对缓存整篇替换、核对记录和全文往返、改 key、没人用的全文删掉；`test/migrations.test.ts` 里有 2 → 3 的升级。
- `test/repositories.test.ts`：五个仓储的往返（Session：分段、排序、按 agent 会话 id / 终端找、改状态、删父和删工作区后子 session 还在）、`terminals.prune`、查询排序、唯一约束、外键和级联、`transaction` 回滚和嵌套。

## 不许碰

- `packages/contracts`：缺字段写进本目录的 `CONTRACT_NOTES.md`，由集成负责人决定。
- 其他包、根目录配置。依赖只加在本包的 package.json。
- 本包不依赖 ui、不依赖 Electron，也不写死数据库路径。
