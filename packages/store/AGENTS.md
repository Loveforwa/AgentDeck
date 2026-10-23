# @agentdeck/store

AgentDeck 的本地数据，SQLite（better-sqlite3）。实现 contracts 的 `BoardStore`，另外给主进程里的服务提供项目、工作区、终端恢复信息、批准记录四个仓储。

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
store.transaction(() => { ... }) // 几步写入放进一个事务，抛错全部回滚；可以嵌套
store.close()
```

- 仓储的类型在 `src/types.ts`，不在 contracts：它们只在主进程里用，不过 IPC。
- 仓储是**同步**的（better-sqlite3 本身同步，同步才能放进 `transaction`）。服务对外是异步接口，自己包一层即可。
- `put` 都是“有就整条更新、没有就插入”（`ON CONFLICT DO UPDATE`，不会触发级联删除）。部分字段的合并（比如 `ProjectPatch`）由服务先 `get` 再 `put`。
- `openStore` 打开时自动跑迁移；文件所在的文件夹不存在会建出来。打开失败（比如数据库来自更新版本的应用）抛 `AgentDeckError`，code 为 `unsupported`。

## 表结构（迁移 1）

| 表 | 主键 | 内容 |
| --- | --- | --- |
| `schema_version` | version | 已跑过的迁移：version、name、applied_at |
| `board` | id（只能是 1） | `state`：整份 `BoardState` 的 JSON；`saved_at` |
| `projects` | id | `Project`；`path` 唯一；`repos`、`copy_into_worktrees` 是 JSON；`missing` 0/1；索引 `last_used_at DESC` |
| `workspaces` | id | `Workspace`；`project_id` → projects（级联删除）；`repos` 是 JSON；每个项目最多一个 `mode = 'main-folder'`（部分唯一索引） |
| `terminals` | terminal_id | 恢复信息：window_id（唯一，可空）、workspace_id → workspaces（级联删除，可空）、agent、cmd、args（JSON）、cwd、session_id、start_command、last_status、exit_code、updated_at |
| `approval_history` | seq（自增） | `ApprovalRecord` 拆成列：request_id、terminal_id、workspace_id → workspaces（级联删除）、agent、kind、summary、command、destructive、requested_at、by、at；索引 `(workspace_id, at DESC)` |

几个约定：

- 删项目 → 它的工作区 → 工作区的终端记录和批准记录，一路级联删掉。散放终端（workspace_id 为空）不受影响。
- 同一个窗口重启后恢复会拿到新的 terminalId：`terminals.put` 会把这个窗口原来那条记录替换掉。窗口关了、终端还在后台跑时 window_id 为空，可以有多条。
- 枚举类的列（kind、mode、agent、last_status、by）没加 CHECK：SQLite 改 CHECK 要重建表，而 contracts 允许往枚举里加值。类型由 TypeScript 保证。
- 时间都是 ISO 字符串，排序直接按字符串比。
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

- `test/migrations.test.ts`：空库建表、重复执行不变、升级保留数据、失败回滚、断外键回滚、拒绝新版本的库、迁移序号不连续。
- `test/board.test.ts`：空库加载、往返、整份替换、中途失败回滚、拒绝未知版本、关闭重开。
- `test/repositories.test.ts`：四个仓储的往返、查询排序、唯一约束、外键和级联、`transaction` 回滚和嵌套。

## 不许碰

- `packages/contracts`：缺字段写进本目录的 `CONTRACT_NOTES.md`，由集成负责人决定。
- 其他包、根目录配置。依赖只加在本包的 package.json。
- 本包不依赖 ui、不依赖 Electron，也不写死数据库路径。
