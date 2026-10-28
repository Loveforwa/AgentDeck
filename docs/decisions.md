# 已定的决策

按时间倒序。改动其中任何一条，先在这里写清楚再动代码。

## 2026-10-28（试用后）

用户试了 integrate/W0-W1 的构建后定的两条。代码在同一分支（4a22f5e；PL6 合进来的 246d737），没合进 main。

- **CO4 去掉 Unseen**：用户觉得多余，状态不用点进去就看得见。
  - 终端标题栏只写 “Idle · 5m”。
  - Agents 视图分 ERROR、NEEDS YOU、RUNNING、IDLE 四组，没有 DONE · UNSEEN。
  - 悬停看最后一条回复、⌥⌘1–9 照旧。
  - contracts 的 `TerminalWindowData.unseen` 留着不用（只加不改），界面不再读写。
- **Prompt queue（PL3）退役，并进 Auto-resume（PL6）**：各家 code agent 大多自己会排提示词，要紧的是撞上额度上限那一刻：恢复时 AgentDeck 把续跑的话发出去，你能改这句话、往里加要求。
  - Auto-resume 贴在白板（默认关）、框、agent 终端上。书签只在终端被额度停下时挂。
  - 卡片里的 Message 是这一次续跑发的话：预填 Settings › General › Resume prompt（没填用内置模板）加上断掉的子 agent；改过的只管这一次。按钮 Reset to default、Resume now、Don’t resume。
  - Don’t resume 在终端上只管这个终端；整个账号不续留给收件箱（CR1）。
  - claude 自己续时：没改话 AgentDeck 什么都不发；改过就马上送进 claude，由它恢复时代发。这一点只用假 claude 验证过，待真 claude 撞一次核对（IS-150）。
  - Keep Mac awake 勾选框去掉，由主进程管。
  - contracts 0.1.23 加可选的 `LimitService.setMessage`，PL3 的队列字段和 `app.setKeepAwake` 只在注释里标 deprecated。
  - 细节见 docs/plugins.md 的决定记录和 DR-84；PL3 的 IS-113 跟着关。

同一天用户又说原来“学习和辅助”页的学习部分（L0：/teach 加一个学习文件夹）太粗，重点是给真实的课把学习环境搭起来（6.5840、CS336 只是例子，设计要通用）。主 agent 按推荐先定了下面这些，需求在设计画布“学习和辅助”页的 L1，任务 M19 LA4–LA13，用例 TC-149～TC-154，调研 DR-120。

- **学习环境（L1，按推荐先定，待你确认）**：
  1. 学一门课 = 白板上一个课程框 + 一份课程配方。配方是纯数据，存在 AgentDeck 的项目设置里，不进课程仓库；内置 6.5840、CS336 两份示例。
  2. Set up a course… 三步：选课和代码 → 选项（在哪跑、导师等级、并行数）→ 在看得见的终端里跑环境检查。修环境的命令只贴不跑。
  3. 官方测试走配方里的命令（6.5840 包 make，不直接 go test）。Repeat runs 只给配方写了 repeat 的单元，并行数按核数和内存自动限流。
  4. GPU：第一期只接你自己的 SSH 机器和本机的 Modal 登录，不替你租、不存平台密钥。长任务用 Jobs（RS1），记花费，机器空闲时提醒你去 destroy。
  5. 导师模式（Tutor）= 只读启动 + 课程的 AGENTS.md + 当前单元的上下文 + 等级。CS336 锁定 Hints only；在课程框里开普通 agent 只提示、不拦。原 L0 的 /teach 改在 Tutor 里用。
  6. 进度仍在你的学习手册和 Obsidian（和 DR-74 一致）。AgentDeck 只记测试证据，用 `agentdeck course status` 给 /check。

## 2026-10-28（第 0、1 波实现）

代码在分支 integrate/W0-W1，没合进 main。做完的任务：PL3、PL5、SE0、SE1、SE2、AH0、AH1、AH2、AH3、AH7、AH11、LA0、PL4（contracts）、CR0（contracts）、CR13、CR14、CR15、DC0、DC1、DC2、CO0、CO3、CO4、SK5；实测 AH6、RS14。contracts 0.1.14–0.1.22 共 9 个版本。用例、问题、调研的状态见 docs/status/tracking.py 和 docs/research/entries.py（新登记 IS-146～149、DR-118、DR-119）。

- **AH7 / AH11 的 MCP 收紧**：AgentDeck MCP 的工具名和参数不变，默认行为收紧三处：① send_to_terminal 在目标终端等你（needs-approval、needs-reply）时拒绝，返回 invalid-argument “This terminal is waiting for the user. Use the inbox.”；文字打出去后、按回车前再查一次，那时在等你就不按回车。原因：往停在批准提示上的终端打 “1” 加回车，等于替人按了批准，绕过收件箱、破坏性名单和 ApprovalRecord；集群里 Lead 也能借它代人批准。批准和回答只走收件箱。② 勾了 Hide from agents 的终端，list_terminals、list_windows 不列，read_terminal、send_to_terminal 返回 invalid-argument “The user hid this terminal from agents”。原因：数据库 TUI 屏幕上的业务数据不该进 agent 上下文，agent 也不该替人往 pgcli 里敲语句。list_windows 也不列是超出原需求的一处（待你确认）。③ list_terminals 返回的 command 一律用 redactCommand 把写明的密码换成 ***。错误码沿用 invalid-argument。两条判断放在 mcp-server 的同一个函数 agentTerminalRefusal 里，/cli 和以后的 Flow 窗口共用。隐藏名单从保存的白板读（有半秒延迟）；读不出白板时工具报错，不当作没隐藏。
- **接口的做法**：contracts 提交只改 packages/contracts，紧跟一个 “Follow contracts” 提交补 fakes 和占位实现（因为 apps/desktop 的 SERVICE_METHODS 穷尽检查，contracts 单独提交一定编不过）。
- **命令行的分工（CR13、CR14）**：按下面第二轮那一节的“命令行分工”（修订 DR-72）落地：crew 全部给 Lead，模板模式的 Worker 等只给 done、note 等几条；session 只给 Lead；doc / flow / lesson / run / job / out / open / notify / help 所有 AgentDeck 终端都有；forge 只给 origin 为 forge 的终端。
- **传输**：现在走 HTTP POST /cli（和 MCP 同一个 127.0.0.1 端口）。CR12 实测（DR-72）后提议改成 unix socket 为主、127.0.0.1 /cli 作回退：codex 的沙箱和 claude /sandbox 能只放一个 socket 路径，放 HTTP 就得放开全部本机端口。**待你确认**；确认后在 apps/desktop 加 socket 监听并写进 api.json，命令行已经会先试 socket。

## 2026-10-28（第二轮：研究和竞赛、文档、学习、代码理解、长期运行、Issue · PR、同仓协作）

来自用户的笔记和 13 点清单。主 agent 补了第 14–16 点，加上原来的第 10–13 点，共 7 点。
- 需求：设计画布新页“研究和竞赛”（E0–E3）、“文档”（D0–D2）、“代码理解”（F0–F2）、“长期运行 · Lessons”（W0–W2）、“Issue · PR”（I0–I2）、“多 agent 同仓协作”（O0、O1）、“学习和辅助”（L0），以及“Agent 接入”页的 A2。
- 任务：M13 LR0–LR11、M14 RS0–RS14、M15 DC0–DC11、M16 CU0–CU8、M17 FG0–FG13、M18 CO0–CO4、M19 LA0–LA3，M10 加 AH8–AH11。
- 用例 TC-85～148，问题 IS-116～145，调研 DR-85～117。

主 agent 按推荐定了下面这些，要用户确认的标在每条后面。

- **研究和竞赛（M14）**：不先做模板。先在自由模式上补记账：
  - Runs：分数由 AgentDeck 在提交上跑锁住的打分命令算；
  - Jobs：长训练由 AgentDeck 看着，先本机，SSH 机器放第二期；
  - Outputs：产物在集群结束前存快照；
  - Submit：Kaggle 只经关卡提交，Auto-approve 永远不放行；
  - Claims：复现时和论文的数对照。

  资料库是一个文件夹，一条一个 Markdown，默认在数据目录。四个研究模板等 CR9。
- **文档（M15）**：文档就是仓库里的 .md 文件。
  - 白板加文档窗口：阅读视图，Edit 是原文编辑。
  - 代码锚点：git blame 加 diff 挪行号，再核对原文。
  - 评论存在 AgentDeck，经 `agentdeck doc` 回到 agent。
  - 逐句核查放第二期。
  - 单击 .md 打开文档窗口，⌥ 单击用编辑器。
- **代码理解（M16）**：agent 写带锚点的序列图（seq.json），静态调用图只当旁证。
  - 覆盖先看图对不对（换一家的 Verifier 核），再叠测试覆盖，最后对上 TC。
  - 草稿存在 AgentDeck，用户点 Save to repo 才进 `docs/flows/`。
  - 不引入 Octop（待用户确认是 TencentCloud/Octop）。
- **长期运行 · Lessons（M13）**：DR-74 补一条例外。
  - 反复踩的坑（Lessons）归 AgentDeck，按项目存，用户点 Accept 才生效。
  - 每条一句话，项目上限 1,000 token。
  - 开 session 时追加进系统提示；用户点 Move to AGENTS.md 才写进仓库，不提交。
  - 单 agent 全天：扩展 PL3 的队列（Run all day），执行搬进主进程；PL3 第一版照原样提交。（PL3 2026-10-28 退役，队列要另起，待定，见 DR-107。）
- **Issue · PR（M17）**：
  - 对外发言（评论、推送、开 PR、回 review、合并）只进收件箱的 “Ready to post”，用户点了才用用户的 gh / glab 发出去。
  - AgentDeck 不存令牌，从 issue 开的终端不带推送凭据。
- **同仓协作（M18）**：
  - 两个框改了同一个文件时提前提示（L2）；合并前在内存里预演（L3）。都只提醒、不拦，不做硬锁。
  - 借“牧羊人”的四样（待用户确认是 Shepherd Terminal）：Agents 视图、Unseen、悬停看最后一条回复、Send selection to ▸（CO3，只粘贴不发）。Unseen 2026-10-28 试用后去掉，见最上面。
- **新 agent（M10 AH8–AH10）**：
  - OpenCode 用官方插件接，过了合格测试按能力报告进第一档，排在集群第一期之后。这一条改了 DR-79 “只深做 claude、codex”。
  - Hermes 按 Nous Research Hermes Agent 通用档接，不往 `~/.hermes` 装插件（待用户确认）。
- **学习和辅助（M19）**：
  - /teach 不内置。
  - 数据库 TUI 加启动预设、Custom command… 和 Hide from agents。命令里带密码时直接挡住。
  - agent 能看到命令里的密码、读到数据库终端（IS-129，P1），用 AH11 修。
- **命令行分工**（修订 DR-72）：
  - 开 session、管子 session、跑 crew 流程的命令只给 Lead。
  - `agentdeck doc / flow / lesson`，以及研究集群的 run / job / out 记账命令，所有 AgentDeck 终端都有。这些命令都不能开终端、批准、提交、合并。
  - 自由模式的子 session 改为“不带 crew 和 session 命令”。
- **往用户文件写东西**都要用户点了才写，AgentDeck 不提交：Save to repo、Move to AGENTS.md，以及用户另选位置的资料库文件夹。

## 2026-10-28（下一代 harness 九点：Session、接入加固、Skill 管理、远程、集群补充、Auto-resume）

起因是用户贴来的一篇讲“下一代 Harness”的文章。这次调研了 9 点（第 8、9 点是用户加的），由主 agent 定下面这些。2026-10-28 用户确认：Auto-resume 改成默认关、产品改名为 Trireme，其余都按推荐。

- 需求：设计画布
  - “Agent 集群”页 C6–C9；
  - 新页“Session”（S0、S1）、“Agent 接入”（A0、A1）、“Skill 管理”（K0、K1）、“手机 · 远程”（R0、R1）；
  - “MVP 插件”页 PluginResume。
- 任务：M9 SE0–SE6、M10 AH0–AH7、M11 SK0–SK7、M12 RM0–RM4、M8 CR10–CR21、M7 PL4–PL9。
- 用例 TC-46～84，问题 IS-91～115，调研 DR-66～84。

决定：

- **继续跑原生 TUI，协议只当旁路**（DR-66）。各家 agent 的复杂度用三样管住：统一的能力报告（AH0）、每家都过的合格测试和 compat 记录（AH2）、版本超过核对版本时自动关掉认屏和按键类功能（AH3）。codex `--remote` 先调研（AH5）。
- **AgentDeck 有自己的 Session**（M9，DR-68）：存在 SQLite，窗口只引用它，父子关系存在 Session 上。关窗口时进程停掉，session 留下，Reopen 恢复名字和设置。`/clear`、compact 算同一个 Session 的新一段。
- **换一家接着做**：开一个子 session，第一条消息是交接说明，不转换各家的对话格式（SE6，CR8 用它）。
- **集群有两种模式**（DR-71）：
  - 自由模式（No template）：流程交给 Lead。只有 Lead 能开子 session、同时几个的上限、只开勾选的几家、worktree、子 session 表、收件箱、合回 main 永远你点，这些由 AgentDeck 守。
  - 模板模式：照 2026-10-27 的设计。
  - 第一期顺序：CR1 → 1a 自由模式 → 1b 模板模式。
  - 两种模式互转放第二期（CR11）。
- **crew 和 session 命令做成 `agentdeck` 命令行，只给 Lead**（DR-72）：现有 11 个 MCP 工具不动。实测 AgentDeck MCP 每轮约 2.1k token，延迟加载时约 360，所以省 token 不是主要理由。真正的理由有两个：Worker 拿不到开 session 的命令；能跑 shell 的 agent 都能进集群。另外，每个终端一把自己的钥匙（`AGENTDECK_TERM_KEY`），不再共用 token（IS-101）。
- **进度以任务表加 Decisions 为准，Lead 的上下文只当缓存**（DR-73）：`crew status` 由代码生成摘要，压缩或重开后用 SessionStart 钩子塞回去。收件箱按集群分组，可以 Ask lead。Lead 只能写建议；第二期你授权后，可以替你回答 worker 的问题；批准和关卡永远你点。
- **长期记忆不由 AgentDeck 管**（DR-74）：集群里非 Lead 的 claude 关掉 auto memory，只通过启动环境，不改用户配置。
- **`send_to_terminal` 不许往正在等你的终端里打字**（IS-102，P1）：用 AH7 修，不等集群。
- **搜索 AgentDeck 不做**（DR-76）。
- **远程分三步**（M12，DR-77）：
  1. 推送；
  2. 只读手机页（只听 127.0.0.1，经 `tailscale serve`，扫码配对，再对上 Tailscale 账号）；
  3. 手机上处理，但不能 Merge into main、不能批破坏性命令（2026-10-28 用户确认）。
- **定位**（DR-79，用户确认）：几家 agent 一起把大任务可靠地做完，你只在关卡出现。跨家协作、白板看全局、原生 TUI 是基础设施底座；在它上面的复杂业务场景（集群、研究和竞赛、文档、issue / MR……）各自单独设计。集群排在所有新方向前面，M5、M6 只做验收、修问题。和开源项目 Agent Deck 同名（IS-109）：先在 README 加一句区分，用户定：**改名为 Trireme**（2026-10-28 查过 GitHub、npm、Homebrew、域名和美国商标，没撞上开发工具和软件商标；trireme.com / .ai / .io / .dev / .app 都已被注册，用 trireme.sh 或 triremeapp.com；结果见 IS-109，改名做法见 CR22）；改名之前 README 先加一句区分。
- **Skill 管理**（M11，DR-81）：
  - 只读扫描五家的目录做总览；
  - 一处存放 = AgentDeck 的库，加上各家目录（只读，当作来源）；
  - 按“全局 → 项目 → 终端”三层启用；
  - 用各家的启动参数把用户目录里的 skill 设成 Names only 或 Off；
  - 按需加载放第二期。
  - AgentDeck 永远不写、不删、不搬用户的 skill 目录。
- **额度恢复后自动续跑另开插件 Auto-resume**（PL4–PL9，DR-84）：
  - 只看这一轮是不是被额度结束的。先续跑，做完再发 Prompt queue（2026-10-28 试用后 PL3 退役，见最上面）。
  - 按“agent + 配置目录”算账号，同一账号的一起停，恢复后每 30 秒续一个。
  - claude 自己会续的，AgentDeck 不重复发，只补发“接回 failed 的子 agent”那一段。
  - 集群终端归 CR8。
  - 识别、归组、错开发送只在主进程的 LimitService 里写一份。
  - 用户定：**默认关**（要用时右键白板打开），名字叫 Auto-resume，PL3 发第一条改成按账号，Mac 睡过头时先问你。
- **PL3 提交前先修 IS-113**：claude 自己续跑成功后，PL3 记下的上限被清掉，排着的提示词再也不发。修法：加 armed 标记，等 claude 续完那一轮再发，stale 时不粘贴。（PL3 后来退役，见最上面）

## 2026-10-27（M8 · Agent 集群）

需求见设计画布“Agent 集群”页（C0–C5），任务 CR0–CR9，调研 DR-64、DR-65。

- **模板定结构，agent 填内容；调度器是 AgentDeck 里的代码，不是 agent。** 派活、开 worktree 和终端、跑检查、比对 owns 目录、锁 contracts、换家审、合并、等额度、重启后对账都由调度器做；拆任务、写代码、审代码、解冲突交给 agent。
- **界面上叫 Crew。**
- **任务表只存在 AgentDeck 里（SQLite），不往仓库写**；agent 用 crew 工具读写（2026-10-28 改成 `agentdeck` 命令行，见上）。
- **默认分工**：总设计 claude、实现 codex（用完换 claude）、审查 claude、验收 codex；审查永远换一家，最多两轮。
- **同时最多 3 个 agent**（New crew 里可改）。
- **收件箱（CR1）先单独做**：所有终端等你的事集中在顶栏 “Needs you · N”，⌘J 打开；原来 ⌘J 依次跳到等你的窗口，改成在列表里选、回车跳过去。
- **第一期只给 claude、codex、omp**：pi、kimi 没有 AgentDeck MCP；omp 进集群前先修 IS-76。
  - 2026-10-28 放宽（2026-10-28 用户确认）：crew 命令改成命令行后，第一期能当 Lead 和 Worker 的是 claude、codex、omp、pi，kimi 灰掉（“Needs approval for every command”）；自由模式的子 session 不带工具，五家都行。第一条消息由调度器在启动后发，IS-76 不再挡集群，但照常修（AH1）。
- **合回 main 永远由你点**，不能在 New crew 里取消这个关卡。

## 2026-10-25（X6 · 恢复上次会话）

- **重开应用时只要有终端窗口的 tmux 会话没了，就问一次 “Restore your last session?”**（Restore all / Not now）；会话都在（普通 ⌘Q 再打开）不问。tmux 服务在应用开着时没了（`terminal.host-lost`）也问。Not now 之后每个窗口自己有 Restore / Restart。
- **agent 按记下的会话 id 接回**（各适配器的 resume 参数），没记下就新开并说明；**Shell 在原目录重开、上次的命令填进输入行不运行**（`CreateTerminalRequest.prefill`，tmux-host 等提示符画出来后 `send-keys -l`，去掉换行）。自定义命令也按 Shell 恢复，不直接再跑。
- **Shell 上次跑的命令靠 tmux-host 看终端的前台进程组（ps）记下**（`TerminalInfo.foregroundCommand` → `TerminalWindowData.lastCommand`），不读 shell 历史文件（分不清哪个终端）、不往用户的 shell 配置里加钩子。跑得很短的命令记不到，没记到时退回 `startCommand`。

## 2026-10-24（M1 · AgentDeck 的 MCP）

- **AgentDeck 自己提供一个 MCP 服务**（`packages/mcp-server`），白板里的 agent 用它开终端、开工作区（worktree + 分支 + agent）、开网页、看和指挥别的终端。
- **跑在主进程里，走 HTTP**，只听 127.0.0.1，固定端口 47621（被占用时随机）。认证用 `~/.agentdeck/run/mcp-token`，调用者靠请求头里的终端 id 认出来。不用 stdio 小命令。
- **只给 claude 自动挂上**（启动时 `--mcp-config`，和用户自己的 MCP 合并，不改任何配置文件）；codex 以后再说。
- **agent 通过 MCP 做的操作直接执行**，白板上不再确认（claude 调工具时自己会问一次，除非用户放行了）。新开的窗口不抢焦点，只闪一下。

## 2026-10-23（第 2 波合并后）

- **最低 tmux 从 3.3 改成 3.5**，见下面那条。
- **claude 的钩子用 `--settings` 临时注入**：实测和用户自己的钩子合并、不替换（用户开了 `disableAllHooks` 时我们的也被关掉，状态退回看输出活动）。
- **codex 的钩子用 `-c hooks.<Event>=…` 临时注入，并用 `-c hooks.state=…` 只信任我们自己的钩子**（启动前起一次 `codex app-server` 调 `hooks/list` 拿哈希）。不用 `--dangerously-bypass-hook-trust`。拿不到就不带钩子启动，退回看输出活动。
- **状态机兜底**：claude 里拒绝批准、按 Esc 打断都不触发钩子；用户输入后 3 秒没有输出也没有钩子，就算这一轮结束（需要 tmux-host 发 `terminal.input`）。
- **提问永远不自动批准**：claude 的 AskUserQuestion 走 PermissionRequest 钩子，适配器把它转成 question，Approve all 和 Auto-approve 都不碰。
- **嵌入的本地页面**：主进程把本地来源（localhost / 127.0.0.1 / [::1]）响应里的 Set-Cookie 改成 `SameSite=None; Secure`，服务端写的登录 cookie 在 iframe 里能用；页面 JS 写的 cookie、第三方 OAuth、弹窗在 MVP 里用 Open in browser；P1 的独立窗口模式用 `<webview partition>`。

## 2026-10-23

- **MVP 只支持 macOS。** Linux 等 macOS 版能用之后再做；Windows 需要 WSL，不在计划内。CI 仍在 Ubuntu 上跑单元测试，只是不保证 Linux 上能用。
- **tmux 用用户自己装的，要求 ≥ 3.5（推荐 3.6）。** 3.5 才有 `extended-keys-format`，codex 的 Shift+Enter 靠它（F7 实测）；Ubuntu 24.04 自带 3.4 不够。 启动时检测 `tmux -V`；没装或版本太低，显示一页说明（`brew install tmux`）和 Retry，不自动安装。随应用打包 tmux 推迟到 MVP 之后。
- **agent 用登录 shell 的环境启动。** 从程序坞打开的 Electron 拿到的环境很少（PATH 里没有 `/opt/homebrew/bin`、`~/.local/bin`，可能缺登录相关的变量），会导致找不到 claude 或 403。启动时运行一次 `$SHELL -ilc env` 读出环境（超时 3 秒，失败时退回当前进程环境并提示），由 apps/desktop 读出后传给 tmux-host（建会话时 `new-session -e`）和 agent-adapters（检测安装、拼启动命令）。两边都通过构造参数拿到这份环境，不自己去读。
- **claude 在 tmux 里要设 `CLAUDE_CODE_TMUX_TRUECOLOR=1`**，否则它检测到 `$TMUX` 会自己降到 256 色。由 claude 适配器在 LaunchSpec.env 里加。
- **先不推到 GitHub。** 用户给出仓库名后再建私有仓库并推送；在那之前 CI 只在本地跑 `pnpm check`。
- **contracts 并发期间只加不改**；`BranchChoice.from` 改为可选、kill 后发 `terminal.exit`（128 + 信号）见 contracts 0.1.1。

- 2026-10-25：X2（其他 agent 的“等你”文字、Settings › Agents）不做；X10（框选多选、⌘Z / ⌘⇧Z 撤销白板操作）做；X4（Fork 对话）等用户看完使用场景再定。

- 2026-10-25：X4（Fork 对话）做：用 agent 自己的接回参数复制对话（claude `--resume <id> --fork-session`、codex `fork <id>`、pi / omp `--fork`），原来的对话不动。
- 2026-10-25：打包成 macOS APP（.dmg），README 顶部（语言链接上方）放下载链接，指向 GitHub Releases。
- 2026-10-25：GitHub 仓库名 AgentDeck（账号 Loveforwa），用户审完 README 再建仓库、推送。README 正文英文，另有中文、日文等共 7 种语言版本，配截图和 GIF；语气平实，只说工具做什么、举几个例子。
- 2026-10-26：N10 后台 agent（画板 13）先做 claude：钩子加 SubagentStart / SubagentStop，读子 agent 自己的记录，只读、不保存（重开应用后从空开始）。
- 2026-10-26：后台 agent 面板打开时项目框跟着长到装下侧边栏和记录窗口，挤到的框、盖住的窗口挪开；收起时照原样放回（这期间布局被别的操作改过就不动）。插件挂在窗口外框外面的东西（Auto-approve 书签、后台 agent 的小提示、Usage 条）也算进框里，框只变大。
- 2026-10-26：N11 左边栏的历史会话（画板 14）：外形和右边栏一样，按项目 → 工作路径 → agent 分，会话按最后活动倒序；只读各 agent 自己的会话文件；开着的单击跳过去，没开着的 Resume / Fork。
- 2026-10-26：N12 项目框一键排版（画板 15）：Tidy、Columns、Rows 三种排法和 Auto-arrange 开关。Tidy 不改窗口大小；Auto-arrange 开着时新开和关掉窗口都重排（画板上两个“待你定”都按画的来）。
- 2026-10-26：顶栏加回成一条横栏（和 macOS 红黄绿按钮同一行，底色 + 底边线），白板在它下面。推翻 10-25 的“没有横栏、白板铺到最上面”：放大的窗口会盖住顶栏，内容平移到顶栏下面时和文字叠在一起（IS-84）。
- 2026-10-26：放大的窗口在你平移、缩放白板（含 ⌘1、⌘J、⌘−、捏合）时自动还原到原来的位置，视口不动，算一步可以 ⌘Z。放大 / 还原自己的视口动画不触发。
- 2026-10-26：点框标题右上角的排版图标时，框的右上角不动（图标留在指针底下，连点几种排法不用找按钮）；Auto-arrange 因新开、关掉窗口自动重排时仍是左上角不动。
- 2026-10-26：N11 左边栏的实现：占白板左边一列（白板跟着变窄，不浮在白板上），默认收着，收起时只剩顶栏最左边的按钮，开关和宽度（240–480）随白板保存（BoardState.leftPanel，contracts 0.1.12）。会话列表开着时每 15 秒刷新；悬停的说明用系统提示，不写消息数（要读整个文件，DR-62）。/tmp 和 /private/tmp 当成同一个目录（macOS 的链接）；Other folders 里的目录写成 ~ 开头，太长只留最后两层。
- 2026-10-26：左边栏去掉按 agent 筛选的那一行（All / claude / codex …，用户觉得不好看、不需要），改成用颜色区分 agent。“颜色只表达状态”这条全局规则因此放宽：每种 code agent 有一个身份色（design-tokens 的 `--agent-claude` 陶土、`--agent-codex` 深蓝（暗色是偏灰的钢蓝）、`--agent-pi` 紫、`--agent-omp` 青、`--agent-kimi` 蓝灰），只用在区分 agent 的身份标记上（现在是左边栏 agent 小标题前的小方块和字），不表示状态；方块不是圆点，免得和状态灯混；色相和明暗都和绿 / 黄 / 红的状态色、Auto-approve 的红、对齐线的蓝错开，作文字过 4.5:1。
- 2026-10-26：左边栏的 Other folders（不在 AgentDeck 里的目录，本机有几十个）默认收起，只露标题和会话总数，点一下展开、再点收起；开着没有记在这台电脑上（浏览器存储，每个人自己的习惯），搜索时照常展开。不隐藏临时目录，也不加 Add as project…（用户没选）。
