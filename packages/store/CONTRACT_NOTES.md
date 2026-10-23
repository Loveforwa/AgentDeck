# 对 contracts 的意见（F8 · store）

做存储时发现的缺口。都没有改 contracts，等集成负责人决定。

1. **Settings 存在哪里没定。** `app.ts` 有 `AppService.getSettings / updateSettings`，但没说由谁保存。建议由本包加一个 `settings` 表（一行 JSON，和 board 一样），作为迁移 2；组装时 AppService 用它。需要的话本包可以先加上。

2. **散放终端的批准记录查不到。** `ApprovalService.history(workspaceId, limit)` 只能按工作区查，而 `PendingRequest.workspaceId` 可以是 null（散放在白板上的终端）。这些记录本包会照样存（workspace_id 为空），但接口里没有办法取。如果需要，可以加 `history(workspaceId: WorkspaceId | null, limit)` 或按 terminalId 查。

3. **Auto-approve 存了两处。** `FrameNode.autoApprove` 在白板 JSON 里，`ApprovalService.setAutoApprove(workspaceId, on)` 在主进程里改。主进程的钩子判断要读这个开关，但白板 JSON 是界面整份写入的，两边容易不一致。建议明确：以哪一方为准；如果以主进程为准，可以在 workspaces 表加一列 `auto_approve`，FrameNode 上的只做显示。

4. **空白板的 `savedAt` 没说填什么。** 本包填 `NEVER_SAVED`（`1970-01-01T00:00:00.000Z`，从 `@agentdeck/store` 导出），表示从没保存过。如果界面要据此判断“第一次启动”，建议在 contracts 的注释里写明，或者加一个常量。

5. **终端最后状态不在 `TerminalWindowData` 里。** 恢复上次会话要知道终端退出前是什么状态、退出码，本包的 `terminals` 表存了 `last_status`、`exit_code`，但 contracts 里没有对应的读取接口（`TerminalHost` / `StatusService` 都只管当前进程）。X6（恢复上次会话）做的时候可能需要在 contracts 里加一个“上次会话”的查询。
