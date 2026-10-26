# @agentdeck/history-panel

左边栏的历史会话（MVP v3 · N11，画板 14，IS-86，调研 DR-62）。项目 → 工作路径 → agent，会话按最后活动倒序；开着的有状态灯、单击跳过去，没开着的 Resume / ⋯（Fork into、Copy session id、Reveal in Finder）。

界面包：只依赖 contracts、design-tokens、ui-kit 和 React。白板数据和动作由组装方（apps/desktop）用 props 给；会话列表默认从 `window.agentdeck.history.list()` 取，开着时每 15 秒刷新。分组是纯函数 `buildHistory`（src/model.ts），测试直接调。

还没接进 apps/desktop（左边栏的开关、宽度 `BoardState.leftPanel`、顶栏按钮）——见 N11 的剩余步骤。

测试：`pnpm --filter @agentdeck/history-panel test`。
