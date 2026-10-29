# 草稿

调研时各点 agent 写的草稿，任务表里的任务会引用它们。做到对应任务时以任务说明为准，草稿只是起点。

- `m8-crew-cli/`：第 4 点的草稿。`crew-lead-SKILL.md` 是只给 Lead 的 crew skill（CR16），`worker-prompt-tail.txt` 是发给 Worker 的提示词结尾（做 CR2、CR16 时参考）。
- `m15-docs/`：第 11 点的草稿。
  - `agentdeck-docs-SKILL.md`：自带的文档 skill，DC7 用。
  - `docs.contracts.ts`：文档窗口、代码锚点、评论、核查的接口草图，DC0 用；不参与编译，docs/ 不在 lint 和 typecheck 范围内。
  - `prompts.txt`：发回 agent 的几段提示词，DC5、DC6、DC8 用。
