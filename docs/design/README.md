# 设计文档

这里放的是线上设计文档在仓库里的副本，方便在 GitHub 上看历史和 diff。**以线上版本为准**；线上改了，要把这里同步一下再提交。

| 目录 / 文件 | 线上版本 | 内容 |
| --- | --- | --- |
| `canvas/` | 设计画布 https://claude.ai/artifact/2GtB5izXeQSV3NecUYuLAo | 需求和配图。`canvas.json` 是页和画板的排列（哪一页、哪个画板、位置、大小），`spec/*.dc.html` 是各画板（Spec* 需求页、Plugin* 插件、Crew* Agent 集群、Session* Session、Agents* Agent 接入、Skills* Skill 管理、Remote* 手机和远程，Runs* 后台任务、容器和任务面板，Arrow / Note / Term 等是画图用的零件）。只放还要做的需求；做完的页改名“已完成 · …”挪到后面（2026-10-29 起），最早的第一版、第二版原型已删（git 历史里有） |
| `components/` | 组件库 https://claude.ai/artifact/MhtbtWuttcdQ4b7uEjvbPN | 设计系统：`README.md` 总规则，`tokens.json` 颜色、字号、间距，`components/<名字>/README.md` 每个零件的样子、状态和代码位置，`preview.html` 是预览，`bundle.css` 是从 `packages/design-tokens` 和 `packages/ui/**` 抄过去的样式。文字版是 `docs/components.md` |
| `agentdeck-plan.html` | 已退役（2026-10-29） | 2026-10-23 的实施方案，只留作历史，不再更新；还成立的部分并进了验收报告的“架构” |
| `agentdeck-mvp-plan.html` | https://claude.ai/artifact/6A1xdERmHFXrg3p9Bi4ujo | 任务表（只有还要做的任务） |
| `agentdeck-research-log.html` | https://claude.ai/artifact/M9eSh1RhsiZhP9FCPbmnwK | 调研记录网页版（由 `docs/research/build.py` 生成） |

验收报告在 `docs/status/index.html`（由 `docs/status/build.py` 生成，线上 https://claude.ai/artifact/FfnyWBeBAg1oPtyHieMbuu）：做完的需求、架构、证据、用例和问题。

注意：

- `canvas/` 和 `components/` 里的 html 要靠线上页面的运行环境（`support.js`、画布外壳）才能显示，直接用浏览器打开看不到排好的样子，看源码或去线上看。
- 这些画板是设计稿，里面写了颜色值，不受 `pnpm colors` 管；做界面时颜色还是只从 `packages/design-tokens` 取。早期画板的等你橙色、运行中墨色等和现在的红绿灯不一致，以组件库为准（见 `components/README.md` 最后一节）。
- 线上页面的类型自带文件（`artifact-type/`、字体、外壳 `index.html`）不放进来。
