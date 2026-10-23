# @agentdeck/fakes

contracts 里各服务的内存假实现（F6）。第一版只有 TerminalHost 和 GitService，其他服务随后补上。

- `FakeTerminalHost`：回放 `recordings/*.json`，发 terminal.* 事件。
- `FakeGitService`：内存里的仓库、分支、worktree、改动。
- `createTempRepo()`（`@agentdeck/fakes/temp-repo`，只能在 Node 里用）：真实 git 的临时仓库。

测试：`pnpm --filter @agentdeck/fakes test`，类型检查：`pnpm --filter @agentdeck/fakes typecheck`。
