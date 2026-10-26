# AgentDeck 调研记录

实现过程中和一开始设想不一样的地方：原来以为什么、实际是什么、怎么决定的、好处和代价。
由 `docs/research/build.py` 从 `docs/research/entries.py` 生成，不要直接改这个文件。更新于 2026-10-26。

共 62 条：已解决 40，进行中 13，推迟 4，待验证 5。

编号规则（全项目统一）：DR-xx 调研记录 · TC-xx 端到端用例 · IS-xx 问题 · F1、T2、X3 等是 MVP 任务表的任务编号。用例和问题在 MVP 验收报告（docs/status/index.html）里；每条调研下面列出相关的用例和问题。

## 目录

- **产品形态**：画原型时，和最初想象不一样的地方
  - [DR-01 agent 的对话是在白板上的真终端里，不是我们自己画的界面](#dr-01)（已解决）
  - [DR-02 不要左侧栏，也不要每个框上的 +/− 改动数](#dr-02)（已解决）
  - [DR-03 界面全英文，文档用中文](#dr-03)（已解决）
- **技术方案**：定技术选型时推翻的设想
  - [DR-04 终端进程交给 tmux，AgentDeck 只负责显示](#dr-04)（进行中）
  - [DR-05 Git 不监听文件，只在三个时机刷新](#dr-05)（已解决）
  - [DR-06 白板不靠整体缩放放下更多窗口，而是拖小窗口、变摘要卡](#dr-06)（已解决）
  - [DR-07 状态靠 agent 自己的钩子，不靠识别屏幕文字](#dr-07)（进行中）
- **需求细节**：在设计画布上评论、逐条改需求时改掉的做法
  - [DR-08 运行中的终端换不了目录，拖进别的框只能新开或 Fork](#dr-08)（进行中）
  - [DR-09 添加项目不用从访达拖，改成固定入口](#dr-09)（已解决）
  - [DR-10 项目不一定是 git 仓库，也可以是多个仓库](#dr-10)（进行中）
  - [DR-11 “主力”是用户起的名字，应用不判断](#dr-11)（已解决）
  - [DR-12 “等你回复”的定义收窄](#dr-12)（已解决）
  - [DR-13 “全部选 yes”改成先列清单的 Approve all](#dr-13)（推迟）
  - [DR-14 “关闭”分三种，重开能接回原来的对话](#dr-14)（推迟）
- **接口与并发**：先定接口再并发开发，过程中发现的问题
  - [DR-15 先定接口再并发，接口第一版不够用](#dr-15)（已解决）
  - [DR-16 窗口组件的 props 漏在接口外面](#dr-16)（已解决）
  - [DR-17 每次合并 pnpm-lock.yaml 都冲突](#dr-17)（已解决）
  - [DR-18 检查规则比部分代码晚到](#dr-18)（已解决）
  - [DR-19 并行开发需要正式的仓库目录](#dr-19)（已解决）
  - [DR-20 第 2 波又收到约 30 条接口意见](#dr-20)（进行中）
- **实现中的技术问题**：真正写代码、跑真实 agent 时撞到的
  - [DR-21 跨 contextBridge 的错误会丢掉 code](#dr-21)（已解决）
  - [DR-22 claude 在 tmux 里自己降到 256 色](#dr-22)（进行中）
  - [DR-23 从程序坞打开的应用拿不到 shell 里的环境](#dr-23)（进行中）
  - [DR-24 经过 tmux 后按键手感](#dr-24)（进行中）
  - [DR-25 tmux 先要求用户自己装，不随应用打包](#dr-25)（推迟）
  - [DR-26 dependency-cruiser 命令行拒绝在 Node 25 上运行](#dr-26)（已解决）
  - [DR-27 SQLite 原生模块要按 Electron 重新编译](#dr-27)（已解决）
  - [DR-28 MVP 先只做 macOS](#dr-28)（已解决）
  - [DR-29 代码还没推到 GitHub](#dr-29)（推迟）
  - [DR-30 claude 的 --settings 钩子和用户自己的钩子是合并的](#dr-30)（已解决）
  - [DR-31 codex 的钩子能临时注入，但要处理“信任”](#dr-31)（已解决）
  - [DR-32 拒绝批准、按 Esc 打断时 claude 不发任何钩子](#dr-32)（进行中）
  - [DR-33 claude 的提问是从“权限请求”钩子来的](#dr-33)（已解决）
  - [DR-34 codex 的会话 id 要等第一次输入之后才知道](#dr-34)（进行中）
  - [DR-35 打包后嵌入的 localhost 页面算跨站，登录 cookie 存不进](#dr-35)（已解决）
  - [DR-36 刚接上终端时要替 xterm 回答终端查询](#dr-36)（进行中）
  - [DR-37 tmux 自带的活动提醒不能用](#dr-37)（进行中）
  - [DR-38 codex 退出后还会留下常驻进程，并自己下载更新](#dr-38)（已解决）
  - [DR-39 Claude Code 里配的 codex MCP 坏了，每个新 session 都提示重连](#dr-39)（已解决）
  - [DR-40 主仓库搬家后，修 worktree 要把每个路径传给 git](#dr-40)（已解决）
  - [DR-41 在 AgentDeck 里管理它自己的仓库，切一下分支应用就坏了](#dr-41)（进行中）
  - [DR-45 xterm 的两个默认值和 tmux 不合：回滚为 0 会崩，Unicode 6 宽度会错位](#dr-45)（已解决）
  - [DR-46 claude 的颜色主题不能用用户的全局设置](#dr-46)（已解决）
  - [DR-47 Electron 的 net.fetch 不支持 redirect: manual](#dr-47)（已解决）
  - [DR-48 外部网站用 webview，不再一律 Open in browser](#dr-48)（已解决）
  - [DR-52 白板的吸附、对齐线和不重叠：借鉴成熟的画布工具](#dr-52)（已解决）
- **还没验证的**：已经有对策，但要等对应的线用真东西试过才算数
  - [DR-49 多个窗口同时在等你时，⌘J 怎么跳](#dr-49)（已解决）
  - [DR-50 Settings：用系统程序打开 settings.json 不可靠](#dr-50)（已解决）
  - [DR-51 检测用户装的其他 agent（pi、omp）](#dr-51)（已解决）
  - [DR-53 白板平移能不能用三指](#dr-53)（已解决）
  - [DR-54 子 agent 窗口组的附着菜单用什么形态](#dr-54)（已解决）
  - [DR-55 token 用量从哪读：CC Switch 还是自己读会话文件](#dr-55)（已解决）
  - [DR-56 Auto-approve 怎么替各 agent 按“允许一次”](#dr-56)（已解决）
  - [DR-57 React Flow 手势的两个坑](#dr-57)（已解决）
  - [DR-58 各 agent 怎么在启动时挂上 AgentDeck 的 MCP](#dr-58)（已解决）
  - [DR-59 各 agent 怎么在启动时带上 skill](#dr-59)（已解决）
  - [DR-60 agent 升级后会不会让 AgentDeck 的功能集体失效](#dr-60)（待验证）
  - [DR-61 agent 自带的后台子 agent 能不能读出来、怎么读](#dr-61)（待验证）
  - [DR-62 各 agent 的历史会话存在哪、怎么列出来](#dr-62)（待验证）
  - [DR-42 claude 能不能把对话 fork 到另一个目录](#dr-42)（已解决）
  - [DR-43 Approve all 发的“允许一次”按键对不对](#dr-43)（待验证）
  - [DR-44 经过 tmux 后的手感，要人在真界面上确认](#dr-44)（待验证）

## 产品形态

画原型时，和最初想象不一样的地方

<a id="dr-01"></a>

### DR-01 agent 的对话是在白板上的真终端里，不是我们自己画的界面

状态：已解决 · 出处：设计画布 v2 原型；实施方案「技术选型」 · 旧编号 A1

相关：TC-21、IS-05

- **原来以为**：在 AgentDeck 自己的面板里渲染每个 agent 的对话，统一样式。
- **实际情况**：每家 agent（claude、codex、gemini）都有自己的 TUI，功能和快捷键一直在变；自己重画等于给每家重做一遍界面，永远追不上。
- **决策**：白板上直接放真实的终端，agent 在里面原样运行；AgentDeck 只管窗口、工作区、状态和 Git。
- **好处**：不用适配每家界面，agent 升级我们不用跟；用户在里面的操作和平时一模一样。
- **代价**：没法统一对话的样式；“谁在等你”这类信息只能从外面推断（见 DR-07、DR-12）。

<a id="dr-02"></a>

### DR-02 不要左侧栏，也不要每个框上的 +/− 改动数

状态：已解决 · 出处：原型评论 fb33f60b · 旧编号 A2

- **原来以为**：左侧栏放会话列表；每个工作区框右上角显示增删行数。
- **实际情况**：白板本身就能看全局，左侧栏重复且占地方；改动数在框上没有可操作的东西，只是噪音。
- **决策**：去掉左侧栏，操作都走右键和触控板；改动只在右侧源代码管理面板里看。
- **好处**：白板面积大，界面更安静，更接近“工具”而不是“AI 产品”。
- **代价**：新用户不知道右键能做什么，需要空白状态里给提示按钮。

<a id="dr-03"></a>

### DR-03 界面全英文，文档用中文

状态：已解决 · 出处：评论 9fb04e3d；根目录 AGENTS.md · 旧编号 A3

- **原来以为**：界面文案用中文。
- **实际情况**：产品以后面向的用户和生态都是英文的，界面文字和 agent 输出也是英文。
- **决策**：产品界面上出现的所有文字一律英文；需求说明、注释、文档、提交说明里的解释用中文。
- **好处**：界面和 agent 输出、命令行一致；以后不用整体翻译一次。
- **代价**：需求画板里中英混排，读的时候要分清哪些是界面原文。

## 技术方案

定技术选型时推翻的设想

<a id="dr-04"></a>

### DR-04 终端进程交给 tmux，AgentDeck 只负责显示

状态：进行中 · 出处：实施方案「技术选型」「风险 4」；F7 试验 · 旧编号 B1

相关：TC-10、TC-11、TC-19、IS-05、IS-09、IS-10

- **原来以为**：用 node-pty 在应用里直接起 agent 进程，xterm.js 显示。
- **实际情况**：进程跟着应用走：关掉应用 agent 就没了；看不见的终端也要一直收输出，开多了会卡；重启后的历史要自己存。
- **决策**：所有 agent 跑在 AgentDeck 自己的 tmux 实例（tmux -L agentdeck）里；只为视口里的终端 attach 显示，移出就断开；摘要、链接、活动状态都向 tmux 要。
- **好处**：关掉应用 agent 继续跑，重开直接接上；开很多终端也不卡；用户能在自己的终端里 tmux attach 接上同一个会话。
- **代价**：多了一层 tmux，按键、滚动、颜色都要调（见 DR-22、DR-24）；要求用户装 tmux（见 DR-25）；Windows 没有原生 tmux。

<a id="dr-05"></a>

### DR-05 Git 不监听文件，只在三个时机刷新

状态：已解决 · 出处：实施方案「git 刷新时机」；contracts git.ts · 旧编号 B2

相关：TC-07、IS-26

- **原来以为**：监听每个 worktree 的文件变化，实时刷新源代码管理面板。
- **实际情况**：每个 worktree 都要一个监听器，大仓库开销大；agent 在一轮里会连续改很多文件，实时刷新没意义。
- **决策**：只在切换聚焦、agent 一轮结束（钩子通知）、自己做完 git 操作时刷新，另有手动刷新按钮。
- **好处**：少一个模块；多开工作区没有额外开销；空闲时 CPU 接近 0。
- **代价**：在外部编辑器里改的文件，要等下次聚焦或手动刷新才显示。

<a id="dr-06"></a>

### DR-06 白板不靠整体缩放放下更多窗口，而是拖小窗口、变摘要卡

状态：已解决 · 出处：评论 4b8282c6；实施方案「风险 1」；2026-10-24 门槛从 75% 改成 50%，缩小时显示整屏文字快照（IS-41） · 旧编号 B3

相关：TC-09、IS-23、IS-41

- **原来以为**：双指捏合缩放整块白板，缩小了就能看到所有终端。
- **实际情况**：xterm 用 canvas 画字，被 CSS 缩放后会糊，鼠标选区也会错位。
- **决策**：去掉双指捏合；靠拖边框把窗口改小，小于 320×200 时变成摘要卡（tmux capture-pane 取最后 3 行）；⌘ + 滚轮缩放只留作备用，低于 75% 同样变摘要卡。
- **好处**：真终端永远按 1:1 渲染，字清楚、选区准；摘要卡不用接上终端，不占资源。
- **代价**：不能像地图那样随手缩小看全部；摘要卡只有几行，看细节要点开。

<a id="dr-07"></a>

### DR-07 状态靠 agent 自己的钩子，不靠识别屏幕文字

状态：进行中 · 出处：评论 d101822a；「6 · 终端状态与提醒」状态来源表；线 4 · 旧编号 B4

相关：TC-04、TC-05、IS-01、IS-06

- **原来以为**：用正则匹配终端输出，判断 agent 是在跑、在等批准还是说完了。
- **实际情况**：各家 TUI 一改版正则就失效；看不见的终端没有接上显示，也拿不到屏幕。
- **决策**：claude 用 hooks（启动时 --settings 临时注入），新版 codex 也用 hooks（本机 0.159 已有 PermissionRequest、Stop）；其他 agent 只用 tmux 的输出活动判断运行中和空闲，可选配一句“等你”的文字。
- **好处**：claude、codex 的状态准确，看不见的终端也准；不受界面改版影响。
- **代价**：依赖各家钩子的格式，升级可能变（检测到变了就退回 tmux 活动）；没有钩子的 agent 不会进入“等你”。

## 需求细节

在设计画布上评论、逐条改需求时改掉的做法

<a id="dr-08"></a>

### DR-08 运行中的终端换不了目录，拖进别的框只能新开或 Fork

状态：进行中 · 出处：评论 91112625；「5 · 终端窗口」 · 旧编号 C1

相关：TC-03

- **原来以为**：把终端拖进另一个工作区框，它就切到那个框的目录。
- **实际情况**：进程启动后工作目录就固定了，外面改不了。界面上看起来换了，实际还在旧目录里改文件，右侧 Git 面板就对不上。
- **决策**：终端创建时绑定它所在的框；拖进别的框会弹回原处，询问 New conversation（空白新开）或 Fork conversation（claude --resume <id> --fork-session、codex fork <id>，带着对话去新目录）。
- **好处**：Git 面板显示的永远是 agent 真正在改的目录；Fork 让对话能带过去。
- **代价**：多一步确认；Fork 带过去的只是对话，旧目录没提交的改动不会跟过去；claude 跨目录 fork 还要实测（见 DR-42）。

<a id="dr-09"></a>

### DR-09 添加项目不用从访达拖，改成固定入口

状态：已解决 · 出处：评论 a650ccd5；「2 · 项目」 · 旧编号 C2

相关：TC-01

- **原来以为**：把文件夹从访达拖到白板上就添加成项目。
- **实际情况**：拖拽入口难发现，也容易误操作。
- **决策**：右键 › Add project…、顶栏 Projects ▾ › Add project…、新建工作区对话框里的项目下拉，三处打开同一个选文件夹窗口。
- **好处**：入口固定好找；添加完直接进入新建工作区。
- **代价**：比拖拽多点一下。

<a id="dr-10"></a>

### DR-10 项目不一定是 git 仓库，也可以是多个仓库

状态：进行中 · 出处：评论 de119763、44b1007a、1447b3d2；contracts project.ts · 旧编号 C3

相关：TC-01、TC-02、IS-19

- **原来以为**：每个项目就是一个 git 仓库，每个工作区就是一个 worktree + 分支。
- **实际情况**：有的文件夹没有 git（笔记、脚本）；有的项目是一个文件夹下几个仓库（web、api），要同时改。
- **决策**：项目分三种：单仓库、多仓库（每个工作区给选中的仓库各建一个同名分支的 worktree，agent 在父目录跑）、普通文件夹（只有主目录工作区，面板提示 Initialize Repository）。
- **好处**：覆盖实际的项目形态；没有 git 的文件夹也能用。
- **代价**：多仓库的提交、切分支、失败回滚都要按仓库各做一遍，复杂度明显上升，所以多仓库推迟到 MVP 之后；普通文件夹没有分支隔离，两个 agent 会互相影响。

<a id="dr-11"></a>

### DR-11 “主力”是用户起的名字，应用不判断

状态：已解决 · 出处：评论 d101822a · 旧编号 C4

- **原来以为**：（需求图里写着 lead，看起来像应用能识别谁是主力 agent。）
- **实际情况**：应用没有依据判断谁是主力。
- **决策**：lead 只是用 Rename 起的名字；没改名时标题栏只显示 agent 名。
- **好处**：不做猜测，不会错。
- **代价**：用户要自己改名才能区分同类 agent。

<a id="dr-12"></a>

### DR-12 “等你回复”的定义收窄

状态：已解决 · 出处：「6 · 终端状态与提醒」 · 旧编号 C5

相关：TC-04、IS-06

- **原来以为**：agent 停下来就是在等你。
- **实际情况**：agent 每一轮说完都会停下，大部分时候只是做完了，不是在问你。全都标橙会让提醒失去意义。
- **决策**：只有 agent 用自己的提问工具（如 claude 的 AskUserQuestion）才算“Needs reply”；一轮说完算 Idle；需要批准算“Needs approval”。
- **好处**：橙色提醒少而准。
- **代价**：agent 用普通文字提问时不会变橙，要自己看。

<a id="dr-13"></a>

### DR-13 “全部选 yes”改成先列清单的 Approve all

状态：推迟 · 出处：评论 ed7b7930；「6 · 终端状态与提醒」 · 旧编号 C6

相关：TC-05、IS-12

- **原来以为**：检测到任何窗口弹出 yes/no 确认，就自动全部选 yes。
- **实际情况**：有的确认是危险命令（rm -rf、强推、清数据库）；一点就全批，出了事查不到。
- **决策**：Approve all（⌘⇧J）先列出每条请求要做什么，破坏性命令默认不勾，只选“允许一次”；另有按工作区开的 Auto-approve，默认关，危险命令照样停下，每次留记录。提问和多选永远留给用户。
- **好处**：省掉一个个点 y 的麻烦，又不会误批危险操作。
- **代价**：多一次确认；手动 Approve all 是给终端发按键，依赖各家确认界面的按键（待线 1 核对）。属于 P1。

<a id="dr-14"></a>

### DR-14 “关闭”分三种，重开能接回原来的对话

状态：推迟 · 出处：评论 246224d2；「9 · 保存与重启」 · 旧编号 C7

相关：TC-10、TC-13、TC-14、IS-14、IS-35

- **原来以为**：关掉应用就是退出。
- **实际情况**：用户有时只想让窗口消失、agent 继续跑；有时想彻底停掉；电脑重启后还想接着原来的对话。
- **决策**：Close window（后台继续、照常通知）、Quit（应用退出，agent 在 tmux 里继续）、Stop all and quit（全部结束）。全部停止或重启后，Restore all 按记下的会话 id 精确接回（claude --resume <id>、codex resume <id>），Shell 在原目录填好命令不运行。
- **好处**：三种需求都能满足；同一目录两个 claude 也不会接错对话。
- **代价**：要为每个终端记录启动命令和会话 id；后台常驻占一点内存。属于 P1。

## 接口与并发

先定接口再并发开发，过程中发现的问题

<a id="dr-15"></a>

### DR-15 先定接口再并发，接口第一版不够用

状态：已解决 · 出处：提交 68595fd；tools/fakes/CONTRACT_NOTES.md · 旧编号 D1

- **原来以为**：contracts 0.1.0 写完，各条线照着做就行。
- **实际情况**：写假实现时发现 10 处不够或说得不清：没法恢复 stash、没法删分支（回滚会留下分支）、改了基础分支 status 拿不到、开 agent 不带终端大小（首屏会跳）、删除有改动的工作区没法“确认后强删”、kill 后发不发 exit、attach 后先不先给整屏等。
- **决策**：在各线开工前出 0.1.1，全部只加不改；BranchChoice.from 放宽为可选（不填时每个仓库用自己的基础分支）；kill 后发 terminal.exit（128 + 信号）。
- **好处**：问题在写真实实现之前就暴露并统一了，5 条线不会各猜各的。
- **代价**：多一次版本号和假实现返工；以后各线还会发现新的，需要有人收集合并。

<a id="dr-16"></a>

### DR-16 窗口组件的 props 漏在接口外面

状态：已解决 · 出处：提交 dddf94c · 旧编号 D2

- **原来以为**：白板、终端、网页各做各的，组装时再对。
- **实际情况**：终端（线 1）和网页（线 5）是放进白板（线 2）里的窗口，三条线同时开发，如果不先定“白板给窗口什么”，每条线都会自己发明一套。
- **决策**：contracts 0.1.2 加 WindowComponentProps：所在工作区、聚焦、内容区大小、摘要卡、可见性，以及 updateData、setStatus、openWindow 等回调；线 2 先单独提交注册表。
- **好处**：三条线并发不用等彼此。
- **代价**：接口里多了一块 UI 相关的约定，以后改它要三条线一起配合。

<a id="dr-17"></a>

### DR-17 每次合并 pnpm-lock.yaml 都冲突

状态：已解决 · 出处：第 1 波合并（91aa5d3…67b652e） · 旧编号 D3

- **原来以为**：各条线只改自己的目录，合并不会冲突。
- **实际情况**：几乎每条线都加依赖，锁文件是全仓库共用的一个文件。
- **决策**：合并时先取 main 的锁文件，再 pnpm install 重新生成，最后用 --frozen-lockfile 确认一致。
- **好处**：不用人工比对锁文件；结果和直接安装一致。
- **代价**：每次合并多一步；两条线加了同一个依赖的不同版本时要人工选。

<a id="dr-18"></a>

### DR-18 检查规则比部分代码晚到

状态：已解决 · 出处：提交 b858371、81301d0 · 旧编号 D4

- **原来以为**：第 1 波各包同时开始，CI 规则和代码一起合进来就行。
- **实际情况**：F6 先写完，F5 的 lint 规则后到，合并后才发现 import type 不合规；F4 的 vite.config.ts 用了 node 内置模块，被“界面不能用 node 模块”的规则误伤；ESLint 还扫到了并行 session 的 worktree 目录。
- **决策**：合并后统一修：eslint --fix；边界规则放过构建配置文件并加样例；ESLint 和 .gitignore 忽略 .claude/worktrees。
- **好处**：规则和代码在 main 上一致，之后的线一开始就受约束。
- **代价**：第 1 波合并时多了一次修补提交。教训：检查规则最好在第 0 波就合进去。

<a id="dr-19"></a>

### DR-19 并行开发需要正式的仓库目录

状态：已解决 · 出处：提交 5590e97 · 旧编号 D5

- **原来以为**：在临时目录里先写，后面再说。
- **实际情况**：并行 session 要各自的 git worktree，临时目录没有 git，而且会被清理。
- **决策**：移到 /Users/liu/2026/agenduck，git init，第一次提交后再开第 1 波。
- **好处**：每条线一个分支，互不干扰，能逐个检查、合并。
- **代价**：代码还没推到 GitHub，CI 没在云端跑过（见 DR-29）。

<a id="dr-20"></a>

### DR-20 第 2 波又收到约 30 条接口意见

状态：进行中 · 出处：提交 68024ca、965452f · 旧编号 D6

相关：IS-17、IS-18

- **原来以为**：0.1.1 和 0.1.2 之后接口够用了。
- **实际情况**：4 条线各自发现了不够用的地方：白板只能按 type 写特例、白板没法给窗口发命令、复用窗口重启后失效、拿不到主目录、远端分支、接回已有 worktree、启动前不知道终端 id、codex 会话 id、拒绝批准没有钩子、网页窗口的标题栏等。
- **决策**：出 contracts 0.1.3，全部只加不改；能直接接上的（命令通道、repairWorktrees、stash 来源、假实现）当场改完，其余在各包的 CONTRACT_NOTES.md 里标为“待某条线跟进”。
- **好处**：线 1 一开始就用 0.1.3，不用再改一轮。
- **代价**：有一批新字段已经在接口里、但实现还没用上，要各条线再跟进一次。

## 实现中的技术问题

真正写代码、跑真实 agent 时撞到的

<a id="dr-21"></a>

### DR-21 跨 contextBridge 的错误会丢掉 code

状态：已解决 · 出处：F3 提交 614de9c、6399b8a · 旧编号 E1

- **原来以为**：主进程抛的 AgentDeckError 能原样传到界面。
- **实际情况**：Electron 的 contextBridge 只保留 Error 的 message，自定义字段（code、detail）都会丢，界面拿到的是 code 为 undefined 的普通 Error。
- **决策**：preload 不抛 Error，改成传普通对象，再在页面侧还原成 AgentDeckError；加了专门覆盖这一点的测试。
- **好处**：界面能按错误码处理（例如 dirty-worktree 再确认一次）。
- **代价**：IPC 层多一层包装，别处如果绕过它直接用 ipcRenderer 就会再踩一次。

<a id="dr-22"></a>

### DR-22 claude 在 tmux 里自己降到 256 色

状态：进行中 · 出处：F7 试验；docs/decisions.md · 旧编号 E2

相关：IS-05

- **原来以为**：tmux 配好真彩色，颜色就和直接运行一样。
- **实际情况**：Claude Code 检测到 $TMUX 时会故意降到 256 色，除非设置 CLAUDE_CODE_TMUX_TRUECOLOR。
- **决策**：claude 适配器启动时在环境变量里加 CLAUDE_CODE_TMUX_TRUECOLOR=1。
- **好处**：颜色和直接运行一致。
- **代价**：依赖 claude 的一个内部变量，它改名就失效，需要在升级检查里覆盖。

<a id="dr-23"></a>

### DR-23 从程序坞打开的应用拿不到 shell 里的环境

状态：进行中 · 出处：F7 试验；docs/decisions.md · 旧编号 E3

相关：TC-20、IS-11

- **原来以为**：应用里起的 agent 和在终端里敲命令一样能找到、能登录。
- **实际情况**：macOS 从程序坞打开的应用环境很少：PATH 里没有 /opt/homebrew/bin、~/.local/bin，可能缺登录相关的变量。tmux 服务也只认第一次启动它的进程的环境（F7 发现在 Claude Code 里起服务会把 CLAUDECODE=1 带给所有会话）。F7 当时看到的 403 后来查明是试验环境里 claude 没登录。
- **决策**：启动时运行一次 $SHELL -ilc env 读出登录 shell 的环境（3 秒超时，失败退回当前环境并提示），由 apps/desktop 传给 tmux-host（建会话时 -e）和 agent 适配器。
- **好处**：不管从哪里打开应用，agent 都能找到并正常登录。
- **代价**：启动多一次 shell（几百毫秒）；用户 shell 配置有问题（卡住、报错）时要兜底；tmux 服务要用干净的环境启动，不能继承 Electron 的。

<a id="dr-24"></a>

### DR-24 经过 tmux 后按键手感

状态：进行中 · 出处：packages/tmux-host/AGENTS.md · 旧编号 E4

相关：IS-05

- **原来以为**：（风险 4）tmux 可能吃掉 Esc、⌃C、方向键等，手感变差。
- **实际情况**：F7 用真 claude 和 codex 实测：按键测试两边都通过，codex 的 Esc 中断、一轮中途断开再接上都正常。
- **决策**：用 AgentDeck 自己的 tmux 配置：关掉前缀键和默认绑定、真彩色、扩展按键、escape-time 0 等，结论写进 packages/tmux-host/AGENTS.md。
- **好处**：风险 4 基本排除，线 1 可以放心按这个方案做。
- **代价**：还有 9 项需要人在真界面上确认（见 DR-44）。

<a id="dr-25"></a>

### DR-25 tmux 先要求用户自己装，不随应用打包

状态：推迟 · 出处：docs/decisions.md · 旧编号 E5

相关：TC-19

- **原来以为**：需求里写的是“没有 tmux 就用随应用打包的 tmux”。
- **实际情况**：把 tmux 打进应用要自己编译（依赖 libevent、ncurses）、签名、公证，工作量不小，和 MVP 的核心功能无关。
- **决策**：MVP 要求已安装 tmux ≥ 3.5（F7 实测 codex 的 Shift+Enter 要 3.5 的 extended-keys-format），没装或太旧时显示一页说明（brew install tmux）和 Retry；打包推迟。
- **好处**：省掉编译和签名的工作，先把核心功能做出来。
- **代价**：第一次使用多一步安装；没有 Homebrew 的用户会卡住；Ubuntu 24.04 自带的 3.4 不够（Linux 本来也不在 MVP 里）。

<a id="dr-26"></a>

### DR-26 dependency-cruiser 命令行拒绝在 Node 25 上运行

状态：已解决 · 出处：F5 提交 d3f6425 · 旧编号 E6

- **原来以为**：用 depcruise 命令检查模块边界。
- **实际情况**：本机 Node 是 25（奇数版本），depcruise 命令行直接拒绝运行。
- **决策**：改成在 scripts/boundaries.mjs 里直接调 dependency-cruiser 的 API。
- **好处**：不用降级 Node；规则照样生效，每条都有故意违规的样例证明。
- **代价**：多一个自己维护的脚本；dependency-cruiser 的 API 变了要跟着改。

<a id="dr-27"></a>

### DR-27 SQLite 原生模块要按 Electron 重新编译

状态：已解决 · 出处：packages/store/AGENTS.md · 旧编号 E7

相关：TC-20、IS-36

- **原来以为**：better-sqlite3 装上就能在应用里用。
- **实际情况**：它是原生模块，Node 和 Electron 的 ABI 不同，在 Node 里测试通过不代表在 Electron 里能加载。
- **决策**：store 包的测试在 Node 里跑；组装阶段用 electron-rebuild（或 electron-vite 的配置）重新编译。。2026-10-25 打包实测：两个原生模块都是 N-API 预编译，不需要 electron-rebuild，asarUnpack 即可
- **好处**：store 包可以独立开发和测试。
- **代价**：组装阶段多一步构建配置；CI 也要覆盖 Electron 里加载的情况。

<a id="dr-28"></a>

### DR-28 MVP 先只做 macOS

状态：已解决 · 出处：docs/decisions.md · 旧编号 E8

- **原来以为**：实施方案里写的是 macOS 和 Linux。
- **实际情况**：现在没有人在 Linux 上测；Linux 的桌面通知、程序坞、shell 环境都和 macOS 不同。
- **决策**：MVP 只支持 macOS；CI 在 Ubuntu 上仍跑单元测试，但不保证能用。
- **好处**：测试和适配的面小一半。
- **代价**：Linux 用户要等；有些 macOS 专有的假设可能写进代码，以后要清理。

<a id="dr-29"></a>

### DR-29 代码还没推到 GitHub

状态：推迟 · 出处：docs/decisions.md · 旧编号 E9

相关：IS-29

- **原来以为**：有 CI 工作流就会自动跑。
- **实际情况**：仓库只在本地，GitHub Actions 从没跑过。
- **决策**：等用户给出仓库名，再建私有仓库推送；在那之前每次合并在本地跑 pnpm check。
- **好处**：不会在没准备好时把代码发出去。
- **代价**：macOS 和 Ubuntu 上的 CI 结果未知；不能用云端 session 并行。

<a id="dr-30"></a>

### DR-30 claude 的 --settings 钩子和用户自己的钩子是合并的

状态：已解决 · 出处：packages/agent-adapters/AGENTS.md · 旧编号 E10

相关：TC-04

- **原来以为**：（待验证）启动时用 --settings 加钩子，可能会替换掉用户自己配的钩子。
- **实际情况**：线 4 用临时项目和临时 CLAUDE_CONFIG_DIR 实测：用户的钩子和我们的同时运行，互不影响。只有用户开了 disableAllHooks 时，我们的也被关掉。
- **决策**：照原方案用 --settings 临时注入，不改任何配置文件；disableAllHooks 时状态退回看输出活动，并用 AgentInfo.warning 提示（contracts 0.1.3）。
- **好处**：用户的配置完全不动，钩子也不冲突。
- **代价**：用户关掉所有钩子时我们的状态就不准了，只能提示。

<a id="dr-31"></a>

### DR-31 codex 的钩子能临时注入，但要处理“信任”

状态：已解决 · 出处：packages/agent-adapters/AGENTS.md · 旧编号 E11

相关：TC-04、IS-34

- **原来以为**：（待验证）codex 能不能像 claude 一样在启动参数里加钩子。
- **实际情况**：-c hooks.<Event>=… 能加钩子，但 codex 只运行有“信任哈希”的钩子；--dangerously-bypass-hook-trust 会连项目里没审过的钩子一起放行。
- **决策**：启动前起一次 codex app-server 调 hooks/list 拿我们钩子的哈希，再用 -c hooks.state=… 只信任我们自己的；失败就不带钩子启动。旧版 codex 退回 notify。
- **好处**：不改 ~/.codex/config.toml，也不放行别人的钩子。
- **代价**：每次开 codex 多一次 app-server 往返；依赖 codex 的内部协议，升级要用真 agent 测试复查（线 4 留了 AGENTDECK_REAL_AGENTS=1 的测试）。

<a id="dr-32"></a>

### DR-32 拒绝批准、按 Esc 打断时 claude 不发任何钩子

状态：进行中 · 出处：packages/agent-adapters 状态表第 15 行 · 旧编号 E12

相关：TC-05、IS-01

- **原来以为**：agent 的每个状态变化都会有钩子通知。
- **实际情况**：线 4 用真 claude 实测：拒绝权限请求（Esc 或 No）、运行中按 Esc，都不触发任何钩子，状态会一直停在“等你批准”或“运行中”。
- **决策**：状态机加兜底：用户输入过、之后 3 秒没有输出也没有钩子，就算这一轮结束。tmux-host 在 write / sendKeys 时发 terminal.input 事件（contracts 0.1.3）。
- **好处**：状态不会卡住。
- **代价**：是推断不是事实，3 秒内 agent 恰好没输出又没结束时会短暂误判为空闲。

<a id="dr-33"></a>

### DR-33 claude 的提问是从“权限请求”钩子来的

状态：已解决 · 出处：packages/agent-adapters；contracts agent.ts · 旧编号 E13

相关：TC-04

- **原来以为**：提问和批准是两种不同的钩子。
- **实际情况**：claude 的 AskUserQuestion 以 PermissionRequest（tool_name: AskUserQuestion）的形式到达；如果按批准处理，Auto-approve 会替用户回答问题。
- **决策**：适配器把它转成 question 事件；HookReply 注释写明提问永远回 none（contracts 0.1.3）。
- **好处**：Approve all 和 Auto-approve 不会碰到提问。
- **代价**：依赖 claude 的工具名，改名要同步。

<a id="dr-34"></a>

### DR-34 codex 的会话 id 要等第一次输入之后才知道

状态：进行中 · 出处：contracts status.ts · 旧编号 E14

相关：TC-14

- **原来以为**：启动 agent 时就能拿到会话 id，用来恢复和 Fork。
- **实际情况**：claude 的 id 是我们生成的；codex 的 id 只在 SessionStart 钩子里，而它实测在用户第一次输入之后才来，启动结果里拿不到。
- **决策**：StatusSnapshot 加 sessionId（contracts 0.1.3），界面收到后存进 TerminalWindowData。
- **好处**：codex 也能恢复会话、Fork。
- **代价**：没输入过的 codex 终端没有 id，重启后只能新开。

<a id="dr-35"></a>

### DR-35 打包后嵌入的 localhost 页面算跨站，登录 cookie 存不进

状态：已解决 · 出处：packages/ui/widgets/browser/AGENTS.md · 旧编号 E15

相关：TC-06

- **原来以为**：（风险 3）iframe 里的本地页面可能丢登录态，开发模式下试一下就知道。
- **实际情况**：开发模式下白板也是 http://localhost，和页面同站，看不出问题；打包后白板是 file://，iframe 里的 localhost 算跨站，SameSite=Lax 的 cookie 根本存不进（线 5 实测）。
- **决策**：主进程把本地来源响应里的 Set-Cookie 改成 SameSite=None; Secure，服务端写的登录 cookie 就能用；页面 JS 写的 cookie、第三方 OAuth、弹窗在 MVP 里用 Open in browser；P1 用 <webview partition> 独立窗口模式（实测全部能登录，也能跟着白板缩放）。
- **好处**：大部分本地开发服务的登录直接能用。
- **代价**：改写 cookie 只对本地来源，别的情况要用户点 Open in browser；每个 session 的 onHeadersReceived 只能挂一个，别的模块要改响应头得合并。

<a id="dr-36"></a>

### DR-36 刚接上终端时要替 xterm 回答终端查询

状态：进行中 · 出处：packages/tmux-host/AGENTS.md · 旧编号 E16

相关：IS-05

- **原来以为**：xterm.js attach 上 tmux 就能直接用。
- **实际情况**：tmux 接上时会查询终端版本（XTVERSION）和前景、背景色（OSC 10/11）；xterm.js 不回答的话，之后 5 秒里每次按 Esc 都会被扣住 500 毫秒。刚接上时的 Esc 还可能和终端的应答粘在一起发给 agent。
- **决策**：终端窗口（T2）替 xterm 回答这几个查询，并且在收到第一段输出之前先扣住用户输入（F7 留了参考实现）。
- **好处**：Esc 的手感和直接运行一样。
- **代价**：多一段要维护的终端协议代码。

<a id="dr-37"></a>

### DR-37 tmux 自带的活动提醒不能用

状态：进行中 · 出处：packages/tmux-host/AGENTS.md · 旧编号 E17

相关：TC-04

- **原来以为**：用 tmux 的 monitor-activity / monitor-silence 判断有没有输出。
- **实际情况**：F7 实测 tmux 的提醒钩子不可靠；服务在最后一个会话结束时会退出，运行时挂的钩子也跟着丢；pipe-pane 不和 new-session 放在同一次调用里会漏掉开头的输出。
- **决策**：活动和静默从 pipe-pane 抄送出来的输出流里算；pipe-pane 和 new-session 在同一次 tmux 调用里执行。
- **好处**：看不见的终端状态也准，开头的输出（比如 dev server 打印的地址）不会漏。
- **代价**：tmux-host 要自己维护计时器，比直接用 tmux 的功能多写一些代码。

<a id="dr-38"></a>

### DR-38 codex 退出后还会留下常驻进程，并自己下载更新

状态：已解决 · 出处：packages/tmux-host/AGENTS.md 第 15 条 · 旧编号 E18

相关：IS-34

- **原来以为**：关掉 codex 的终端，codex 就结束了。
- **实际情况**：codex 会在它的 CODEX_HOME 下留一个常驻守护进程（app-server daemon），TUI 退出后还在，还会自己下载新版本。F7 用临时目录测试时留下了 11 个，其中一个下载卡了 40 多分钟。
- **决策**：试验脚本结束时按临时目录清理这些进程；AgentDeck 关掉 codex 终端时不假设它的进程都结束了。
- **好处**：不留垃圾进程。
- **代价**：用户自己的 codex 守护进程不归我们管，codex 升级（这次自动升到了 0.164）可能改变行为。

<a id="dr-39"></a>

### DR-39 Claude Code 里配的 codex MCP 坏了，每个新 session 都提示重连

状态：已解决 · 出处：本次会话 · 旧编号 E19

- **原来以为**：（和 AgentDeck 无关的环境问题）
- **实际情况**：~/.claude.json 里的 codex MCP 用 codex mcp-server 启动，codex 0.159 已经没有这个子命令；并行开了十来个 session，每个都提示 reconnect。
- **决策**：用户同意后用 claude mcp remove codex --scope user 删掉这一项，其他配置不动，删除前留了备份。
- **好处**：不再弹提示。
- **代价**：以后要重新接 codex，得用 codex 新版提供的接入方式。

<a id="dr-40"></a>

### DR-40 主仓库搬家后，修 worktree 要把每个路径传给 git

状态：已解决 · 出处：提交 965452f · 旧编号 E20

- **原来以为**：git worktree repair 在主仓库里跑一下就行。
- **实际情况**：写 repairWorktrees 的测试时发现：不带参数时只修主仓库这一侧的记录，worktree 里的 .git 文件还指向旧位置，打不开。
- **决策**：repairWorktrees 先列出所有 worktree，再把它们的路径都传给 git worktree repair；加了真实仓库搬家的测试。
- **好处**：ProjectService.locate 之后已有工作区能直接用。
- **代价**：worktree 本身也被挪走的情况仍然修不了，只能重新 locate。

<a id="dr-41"></a>

### DR-41 在 AgentDeck 里管理它自己的仓库，切一下分支应用就坏了

状态：进行中 · 出处：问题清单 IS-37、IS-38；用例 TC-24 · 旧编号 E21

相关：TC-24、IS-37、IS-38、IS-31

- **原来以为**：面板切分支只影响那个工作区里的 agent；空闲的终端不会受影响，所以不用确认。
- **实际情况**：2026-10-24 验收时，在 agenduck 自己的主目录工作区里单击了一个遗留分支：终端都是 Idle，面板没确认就切了。AgentDeck 正是从这个目录用 pnpm dev 跑的，开发服务器立刻热更新成旧代码，界面变成早期的自检页并报错。
- **决策**：立刻 git switch main 并重启恢复。之后：只要目录里有任何终端开着就先确认（IS-37）；应用发现要切的目录就是自己运行的目录时拒绝并提示（IS-38）；验收改用别的测试仓库，或在独立 worktree 里跑 pnpm dev。
- **好处**：自举开发不会再被一次误点打断。
- **代价**：切分支多一次确认；开发 AgentDeck 自己时要多维护一个 worktree。

<a id="dr-45"></a>

### DR-45 xterm 的两个默认值和 tmux 不合：回滚为 0 会崩，Unicode 6 宽度会错位

状态：已解决 · 出处：提交 235eb59；packages/ui/widgets/terminal/test/xterm-buffer.test.ts · 旧编号 —

相关：TC-25、IS-39、IS-40

- **原来以为**：tmux 自己管回滚，xterm 的回滚设成 0 就行；xterm 默认的字符宽度够用。
- **实际情况**：2026-10-24 验收时，一个 claude 终端在对话中改窗口大小后变空白（loadCell / isWrapped）。headless 版 xterm 加固定种子模糊测试复现：scrollback 为 0 时改大小，缓冲区会少行。另外 xterm 默认按 Unicode 6 算宽度，emoji 算一格，而 tmux 3.6a 算两格，回答里 ✅ ❌ 后面的字整体错一列。
- **决策**：scrollback 改成 1000（固定种子 1、18、37 在 0 时出事、在 1000 时不出事）；加 @xterm/addon-unicode11 并切到 Unicode 11，对 tmux 实测 35 个 claude 常用符号的宽度，全部吻合。两件事都写成了回归测试。
- **好处**：终端不会因为改大小崩掉；emoji 和中文的排版和系统终端一致。
- **代价**：每个终端多占一点内存（1000 行回滚）；以后 tmux 或 xterm 升级改了宽度表，要重新对一遍（测试会提醒）。

<a id="dr-46"></a>

### DR-46 claude 的颜色主题不能用用户的全局设置

状态：已解决 · 出处：packages/agent-adapters/src/adapters/claude.ts、packages/ui/widgets/terminal/src/queries.ts · 旧编号 —

相关：TC-26、IS-42

- **原来以为**：终端背景色交给 AgentDeck，claude 自己会配合；用户的 claude 配置不用管。
- **实际情况**：claude 的 theme 默认不是 auto：用户 ~/.claude.json 里是 light，claude 就不看背景色，在深色白板上用黑字。实测（2.1.291）：--settings 里的 theme 能盖过全局配置；auto 时 claude 发 OSC 11 问背景色，并订阅深浅色变化。tmux 3.6a attach 时对外层终端开 ?2031，收到 CSI ? 997 n 会转给程序。
- **决策**：启动 claude 时 --settings 加 "theme":"auto"；终端组件记下 ?2031 的开关，白板换深浅色时主动发 CSI ? 997 ; 1|2 n。用一个假装成 xterm 的脚本 attach 真 tmux、跑真 claude，深→浅→深都跟着变。
- **好处**：不改用户的配置文件；深浅色切换时开着的 claude 也跟着变。
- **代价**：用户选的色弱（daltonized）、ANSI 主题在 AgentDeck 里会换成普通深浅色；codex 等其他 agent 还没看；已经开着的 claude 要重开才拿到新参数。

<a id="dr-47"></a>

### DR-47 Electron 的 net.fetch 不支持 redirect: manual

状态：已解决 · 出处：apps/desktop/src/main/browser/ping-fetch.ts · 旧编号 —

相关：TC-27、IS-43、IS-44

- **原来以为**：主进程的 ping 用 net.fetch（走系统代理）加 redirect: manual，服务回了任何 HTTP 响应（包括 3xx）就算在响应。
- **实际情况**：2026-10-24 用户打开 google.com 显示 “isn’t responding”。实测 Electron 45：net.fetch 带 redirect: manual 时，只要地址跳转就抛 “Redirect was cancelled”（google.com → 301）；不跳转的地址（www.google.com）正常。所以所有会跳转的地址都被当成没响应，包括把 / 跳到 /login 的本地 dev server。另外 google、github 都带 X-Frame-Options，就算 ping 通了也嵌不进白板的 iframe。
- **决策**：ping 改用 net.request（redirect: manual）：收到 redirect 或 response 事件就记下状态码、abort，不读正文；不是 manual 的请求仍用 net.fetch。外部网站能不能在白板里显示另外决定（IS-44）。
- **好处**：会跳转的地址判断正确；仍走 session 的网络栈和系统代理；有单测，也在真 Electron 里跑过。
- **代价**：多了一层自己写的请求代码；外部网站在 MVP 里仍然只能 Open in browser。

<a id="dr-48"></a>

### DR-48 外部网站用 webview，不再一律 Open in browser

状态：已解决 · 出处：apps/desktop/src/main/browser/webview.ts、packages/ui/widgets/browser/src/BrowserWindow.tsx · 旧编号 —

相关：TC-28、IS-44

- **原来以为**：MVP 的网页窗口只给本地 dev server 用，外部网站交给系统浏览器；webview 留到 P1、要用户手动切换。
- **实际情况**：用户直接在网页窗口里打开 google.com，期望能看、能登录。google、github 都带 X-Frame-Options，iframe 嵌不进；第三方登录还要 SameSite cookie 和弹窗。风险 3 试验早就证明 webview 能登录、能跟着缩放。
- **决策**：prepare 按地址决定：本地地址用 iframe（改写响应头、小桥），外部网站自动用 <webview partition=persist:agentdeck-web>，不用手动切；iframe 出错页加 Show it here 切到 webview。主进程锁住 webview（去掉 preload 和 node、只认这个分区和 http(s)），分区 UA 去掉 Electron（Google 登录看到 Electron 会拒绝），权限只给剪贴板写入和全屏，window.open 开成同一分区的弹窗，⌘[ ⌘] ⌘R 在主进程里处理。
- **好处**：外部网站在白板里能显示、能登录，登录态重启后还在；和白板页面的 session 分开，不改外部网站的响应头。
- **代价**：应用窗口要开 webviewTag（靠 will-attach-webview 把关）；每个外部网页是单独的渲染进程，内存更多；webview 里 ⌘L 到不了地址栏；Google 可能以后换别的方式识别嵌入式浏览器。

<a id="dr-52"></a>

### DR-52 白板的吸附、对齐线和不重叠：借鉴成熟的画布工具

状态：已解决 · 出处：MVP v2 V3（f05e824），packages/ui/canvas/src/model/snap.ts、avoid.ts · 旧编号 —

相关：TC-31、IS-53、IS-54

- **原来以为**：窗口可以随便摆，用户自己会排好；不需要对齐和避让。
- **实际情况**：第一轮验收里窗口、工作区框互相盖住，框重叠后还把终端误判成要换框（IS-53、IS-54）。调研（凭已有知识，没联网核实）：Figma 的吸附距离按屏幕像素、只对齐同一父容器、标数字、⌘ 临时不吸，不管重叠；tldraw 阈值约 8/缩放，吸附角、边、中心和等间距；Excalidraw 类似，红线加十字；React Flow 的 helper lines 示例只找每个方向最近的一个节点、阈值约 5px。这些工具都不防重叠。
- **决策**：吸附照前三者：6 个屏幕像素（随缩放换算）、每个方向只取最近的一条、同一个框里、⌘ 关闭、标数字，蓝色对齐线（--guide）。不重叠是我们加的：松手时重叠就滑到最近的空位，不推别人；框之间至少 20px，拖框碰到就停，框长大时挡路的框整体挪开；启动时分开已经重叠的框。放大的窗口例外。
- **好处**：IS-54 的误判自然消失；布局越用越整齐，内容不会被盖住。
- **代价**：框可能被自动挪开（只在被挤到时），窗口松手后会跳一下；改框大小时不吸附；散放的窗口只避让散放的窗口。

## 还没验证的

已经有对策，但要等对应的线用真东西试过才算数

<a id="dr-49"></a>

### DR-49 多个窗口同时在等你时，⌘J 怎么跳

状态：已解决 · 出处：已做：feat/S3-jump-waiting，合进 main 45d4b22（按默认：批准和回复不分先后、⌘⇧] 切所有窗口、不做“回到上一个窗口”） · 旧编号 —

相关：TC-05、IS-45

- **原来以为**：⌘J 依次跳到在等你的窗口就够了（MVP 任务表 S3）。
- **实际情况**：用户验收时问：多个窗口在等时按什么顺序跳？是不是该有在多个终端之间移动光标的快捷键？代码里是等得最久的在前、批准和回复不分、跨所有工作区循环，绕回第一个时没有提示，没有反向，也没有普通的“下一个窗口”快捷键（packages/ui/canvas/src/model/attention.ts、shortcuts.ts）。VS Code 的 F8 / ⇧F8、tmux 的 next-window -a 和 n / p 都把“要处理的队列”和“普通导航”分成两套键，并告诉你在第几个。
- **决策**：建议（待用户定）：⌘J 保持等得最久的在前，跳过去时闪一下，顶栏显示 “2/3 waiting”；加 ⌘⇧J 反向；加 ⌘⇧] / ⌘⇧[ 按位置在所有窗口之间切换（先框内、从上到下从左到右）。不改 contracts，约半天。
- **好处**：处理一串等你的窗口时知道在哪、还剩几个；不在等的窗口也能用键盘切换。
- **代价**：多 3 个快捷键要记；⌘⇧] / ⌘⇧[ 要和网页窗口里的按键区分（用 e.code）。

<a id="dr-50"></a>

### DR-50 Settings：用系统程序打开 settings.json 不可靠

状态：已解决 · 出处：已做：claude/x12-settings-dialog-d59137，合进 main 45d4b22（放在 canvas、先做 Projects 和 General、settings.json 用编辑器打开） · 旧编号 —

相关：TC-15、IS-13、IS-47

- **原来以为**：MVP 先不做设置界面，点 Settings 用系统程序打开 settings.json 让用户手改。
- **实际情况**：用户验收时“打开出问题”：这台 Mac 上 .json 的默认程序是 Tor Browser；出错时界面没有任何提示。项目设置的字段（基础分支、worktree 位置、复制的文件、初始化命令）后端都已存好，projects.update 也在 IPC 里，新建工作区时都会用上，只是界面里没有地方能改。
- **决策**：建议（待用户定）：在白板（packages/ui/canvas）里做 Settings 对话框，先做 Projects 和 General 两页；顶栏 Settings、⌘, 和 Projects ▾ 里的 Project settings… 都打开它；底部保留 Open settings.json，改用 editorCommand 打开，失败在 Finder 里显示并用 Toast 提示。不改 contracts，约一天。
- **好处**：不依赖系统的默认程序；TC-15 能通过；后端已有的字段直接可用。
- **代价**：对话框约 250 行新代码；Agents、Approvals 两页另做。

<a id="dr-51"></a>

### DR-51 检测用户装的其他 agent（pi、omp）

状态：已解决 · 出处：已做：claude/x13-known-agents-0267bf，合进 main 45d4b22（两步都做了；pi、omp 用临时 HOME 和假模型实测过事件，omp 的“允许一次”按键没核对，没有 Approve all） · 旧编号 —

相关：TC-17、IS-46、IS-21

- **原来以为**：MVP 只支持 claude、codex 和 Shell，别的 agent 用 Shell 手动启动。
- **实际情况**：用户本机装了 pi（@earendil-works/pi-coding-agent 0.83.0）和 omp（oh-my-pi 18.0.4，pi 的分支），都在登录 shell 的 PATH 里，--version 能取到版本，菜单里没有。适配器写死了 4 个，没有自动发现；没有钩子的 agent 状态只有 running / idle。pi 有 --session-id、--session、--fork；omp 有 --resume、--fork；两者都没有命令式钩子，但都有扩展事件（session_start、agent_end 等，omp 还有 tool_approval_requested），可以用 -e 临时加载。
- **决策**：建议（待用户定）：第一步加已知 agent 表和通用适配器（pi、omp，顺带本机有的 kimi），菜单能列出、能开、能接回，状态只有运行 / 空闲，约半天；第二步 AgentDeck 自带一个扩展用 -e 加载，把事件转成现有的钩子消息，拿到“轮到你”和 Needs approval，约 1–1.5 天；用户在设置里自己加 agent 以后再做（要改 contracts）。
- **好处**：装了什么 agent 菜单里就有什么；不改用户的 ~/.pi、~/.omp 配置。
- **代价**：第一步没有等你提醒；omp 新会话的 id 启动时拿不到，第一步接不回；扩展的做法要实测。

<a id="dr-53"></a>

### DR-53 白板平移能不能用三指

状态：已解决 · 出处：v3 N6 · 设计画布画板 12 · 旧编号 —

相关：IS-59

- **原来以为**：两指滑动在空白处平移白板、在窗口上滚窗口内容，够用。
- **实际情况**：用户希望三指拖动平移白板，两指永远给终端。macOS 的三指拖移是系统辅助功能，应用收到的只是普通的按住拖动，拿不到几根手指。
- **决策**：2026-10-25 用户定：都要。两指在任何窗口上都给窗口（不论是否聚焦），空白处两指平移；打开捏合缩放；空格拖动平移。
- **好处**：不再和终端滚动抢手势。
- **代价**：鼠标停在窗口上时两指不能平移白板，要先移到空白处。

<a id="dr-54"></a>

### DR-54 子 agent 窗口组的附着菜单用什么形态

状态：已解决 · 出处：v3 N2 · 设计画布画板 12 · 旧编号 —

- **原来以为**：agent 开 subagent 是它自己的事，白板只管一个个终端。
- **实际情况**：用户希望 agent 一次开 n 个子终端时白板上看得见、能在一个附着菜单里切换，这个菜单以后也是插件入口。
- **决策**：2026-10-25 用户定：侧边栏（形态 A）。主 agent 旁边一列列出子 agent，选中一个就在右边打开它的终端；关掉主 agent 时子终端留下。
- **好处**：一眼看全一组的状态；和插件条、书签互不冲突。
- **代价**：占一列宽度。

<a id="dr-55"></a>

### DR-55 token 用量从哪读：CC Switch 还是自己读会话文件

状态：已解决 · 出处：插件 PL2 · 设计画布“插件能力”页 · docs/plugins.md · 旧编号 —

- **原来以为**：（没考虑过 token）
- **实际情况**：CC Switch（farion1231/cc-switch，本机 3.20.0，数据在 ~/.cc-switch/cc-switch.db）的用量是事后扫各 agent 的会话文件得到的，按会话能拆开（proxy_request_logs.session_id），但 3.20 每 60 秒扫一次、新版后台 10 分钟一次，没有上下文长度和窗口，omp 不统计，没有读数据的接口；“看 Codex 账号用量”是它查订阅额度（5 小时、每周的百分比），不是 token。各 agent 的会话文件里字段都有：claude message.usage（按 message.id 去重）、codex token_count（含 model_context_window）、pi/omp message.usage（扩展有 getContextUsage）、kimi wire.jsonl 的 usage.record。
- **决策**：终端旁边的实时条由 AgentDeck 自己读会话文件：按终端的会话 id 定位文件，只读新增部分，每次请求后更新；pi/omp 的上下文占比由我们的扩展上报。2026-10-25 用户再定：不接 CC Switch，插件改名 Usage。
- **好处**：实时、有上下文长度、不依赖用户装没装 CC Switch、五种 agent 都覆盖。
- **代价**：要为每种 agent 维护一个读取器，格式随版本变；kimi 新建会话没有 id，只能按目录和启动时间推断；claude 的窗口大小要按模型推断。实现时又发现：claude 的窗口只能按模型查表（用户开了 1M 但还没超过 200k 时会显示 200k）；codex 的 token_usage_record 含压缩请求，累计比 token_count 略多，和 codex 自己的 /status 一样用 token_count；kimi 的 token_counting.measured 只有 2.3 起才有；claude 子 agent 的记录在单独目录，不算进主对话。本机实测 69.6MB 的 claude 会话读一遍 117ms。显示时还要照各 agent 自己的写法：kimi 的 k 按 1024（977k 就是 1,000,000）、百分比向上取整；codex 的占比先扣 12000 的基线。不照着来，数字会和终端里看到的对不上（用户在 kimi 上发现的）。按源码核对后（IS-69）：codex 额度是先把用量四舍五入成整数再用 100 减，写 “x% left”，token 数是 Rust 的一半取偶、大写 K；claude 是小写 k/m、百分比四舍五入；pi 一位小数且不去 .0、omp 大写 K/M；只有 codex 的会话文件带额度，claude、omp、kimi 界面上的额度要另找数据源。

<a id="dr-56"></a>

### DR-56 Auto-approve 怎么替各 agent 按“允许一次”

状态：已解决 · 出处：插件 PL1 · 设计画布“插件能力”页 · docs/plugins.md · 旧编号 —

- **原来以为**：只有 claude、codex 有“允许一次”的按键，其他 agent 支持不了。
- **实际情况**：claude 和 codex 都有 PermissionRequest 钩子，回 decision.behavior=allow 就是只允许这一次、不留规则，AgentDeck 启动它们时已经挂了钩子，开关可以在运行中随时生效；提问（AskUserQuestion、ExitPlanMode、codex 的 request_user_input）不会被误答。kimi 2.3.1 的钩子不能批准，只能看屏幕：选项是 Approve once / Approve for this session / Reject / Reject with feedback，按 1；计划确认和 Start a goal? 用同一个面板，不能答。omp 是 Approve / Deny 选择器，扩展能先报 PermissionRequest，按 ↑ 再 ↵（没在真终端核对）。pi 根本不弹确认框。各家自带的 yolo / auto 模式都只能在启动时定、而且不走我们的破坏性名单，不用。
- **决策**：claude、codex 在 HookServer.decide 里回 allow（终端或它的框开着 Auto-approve、不是破坏性命令时）；开关前已经在等的补发按键（claude 1、codex y）。omp 先核对 ↑ ↵ 再上；pi 不用按，书签照常显示。kimi 2026-10-25 用户定先不做（只能看屏幕）。顺带修 hook-payload.ts 的 FILE_TOOLS 不认 omp 小写工具名的问题。
- **好处**：五种 agent 都覆盖；claude、codex 不靠模拟按键，不会选错项。
- **代价**：kimi、omp 靠看屏幕，版本一变就可能失效，要在 known.ts 记版本；kimi 本机已从 0.29 升到 2.3.1，旧的核对记录过时。

<a id="dr-57"></a>

### DR-57 React Flow 手势的两个坑

状态：已解决 · 出处：v3 N6 · packages/ui/canvas/src/react/Board.tsx、gestures.ts · 旧编号 —

相关：IS-59

- **原来以为**：窗口节点标了 nopan，两指滚动就不会平移白板；React Flow 默认的空格平移不影响终端打字。
- **实际情况**：两指滚动模式（panOnScroll）下 React Flow 只看 nowheel，不看 nopan，所以没聚焦的窗口上两指滚动会平移白板（IS-59 的原因）。它默认的空格平移键在带修饰键时不跳过输入框，会 preventDefault，吞掉终端里的 Shift+空格。
- **决策**：窗口节点和内容一律 nowheel，没聚焦时盖层把滚轮转给内容（终端再派发给 xterm，网页让盖层暂时不接指针）；panActivationKeyCode 设为 null，空格平移自己实现，焦点在终端、输入框、可编辑区时不拿空格。
- **好处**：两指滚动永远给窗口；终端里空格、Shift+空格正常。
- **代价**：缩得很小时窗口变成摘要卡，在卡上也不能两指平移白板；刚点过按钮时焦点在按钮上，空格先给按钮。

<a id="dr-58"></a>

### DR-58 各 agent 怎么在启动时挂上 AgentDeck 的 MCP

状态：已解决 · 出处：v3 N1 · packages/agent-adapters、packages/mcp-server · 旧编号 —

- **原来以为**：每个 agent 都有像 claude --mcp-config 一样的启动参数。
- **实际情况**：codex 0.164 可以用 -c mcp_servers.agentdeck.*（bearer_token_env_var、env_http_headers）挂，命令行上只有环境变量名，和用户配置合并；用临时 CODEX_HOME 跑 codex app-server 不连模型也能测通 MCP。omp 18.0.4 用 --plugin-dir 加载 Claude 插件格式的目录，清单里的 url、headers 支持 ${VAR}。pi 本身不支持 MCP（README：“No MCP.”）。kimi 2.3.1 没有挂 MCP 的启动参数，只能改 KIMI_CODE_HOME（连账号一起换）或往用户仓库写 .mcp.json，而且要用户信任过那个目录。
- **决策**：claude、codex、omp 挂上；pi、kimi 跳过并在 agent-adapters AGENTS.md 写明原因。需求里“自动装载 skill”先用 MCP 连接时附带的说明代替，不往用户配置里写 skill。
- **好处**：不改用户配置，token 不进命令行。
- **代价**：pi、kimi 用不了白板工具；omp 的连接没在真 TUI 里核对。

<a id="dr-59"></a>

### DR-59 各 agent 怎么在启动时带上 skill

状态：已解决 · 出处：v3 N9 · packages/agent-adapters/src/skills · 旧编号 —

相关：TC-39

- **原来以为**：像 MCP 一样，每个 agent 都能用启动参数加 skill。
- **实际情况**：claude 2.1.291 用 --plugin-dir 加载一个插件目录，里面的 skills/ 能被认出（plugin details 核对）；omp 18.0.4 同样用 --plugin-dir；pi 0.83 每个 skill 一个 --skill；kimi 2.3.1 有 --skills-dir，但会顶掉它自动发现的目录，要把那些目录一起传回去（没在真 kimi 里核对）；codex 0.164 的 skills.config 只能开关已经发现的 skill，加不进新的。
- **决策**：claude、omp、pi、kimi 按上面带；codex 的 skill 行灰掉写 “Not supported for codex”。AgentDeck 在数据目录里按内容生成一套 skill 目录（skill-sets/），启动时指过去，不往用户配置和仓库里写东西。
- **好处**：每个终端可以带不同的 skill，不影响用户全局配置。
- **代价**：codex 加不了 skill；kimi 的做法没在真程序里核对；旧的 skill-sets 目录暂不清理。

<a id="dr-60"></a>

### DR-60 agent 升级后会不会让 AgentDeck 的功能集体失效

状态：待验证 · 出处：packages/agent-adapters（known.ts、env.ts、runtime.ts、status/machine.ts、usage）· tools/agentdeck-notify · 旧编号 —

相关：IS-73、IS-74、IS-75、IS-76、IS-77

- **原来以为**：各 agent 的启动参数、钩子、会话文件、确认框都稳定；有 minVersion 下限就够了。
- **实际情况**：耦合点分三类：启动参数（claude --settings/--mcp-config/--plugin-dir、codex -c hooks/mcp_servers、pi/omp -e/--skill/--plugin-dir、kimi --skills-dir）一变终端就起不来（Error · exit），没有自动退回；钩子事件、负载字段、扩展 API、批准回复格式一变，状态灯和 Auto-approve 静默出错（有钩子的终端完全不看输出活动，没有“钩子没来”的检测；回了 allow 就不再进等待）；会话文件、屏幕文字一变，用量和 omp 认屏只是关掉。版本门槛只有下限，版本号读不出时当作够新；内置 skill 默认勾选，让 --plugin-dir、--skill、--skills-dir 变成每次都带的硬依赖。npm 上已有 pi 1.4.0、omp 18.12.6、claude 2.1.310，都没核对、都会自动通过门槛。
- **怎么验证**：（待定，建议）P0：启动保底（起不来就只带会话参数重开并标降级）、版本未知不带可能“挂”的参数、按 --help 探测参数、检测钩子是否活着并退回按输出判断、兼容表记“核对到哪个版本”且超过时关掉按键批准和认屏；P1：版本缓存按二进制修改时间刷新、用量解析报 format-changed、claude/codex 按键批准前也认屏、Settings › Agents 显示每项功能状态、每天跑一次装最新版的兼容检查。

<a id="dr-61"></a>

### DR-61 agent 自带的后台子 agent 能不能读出来、怎么读

状态：待验证 · 出处：v3 N10 · 设计画布画板 13 · packages/agent-adapters/src/subagents · ui/canvas 的 react/Background.tsx、model/background.ts（claude 已做，其他 agent 待调研） · 旧编号 —

相关：IS-85

- **原来以为**：agent 开 subagent 是它自己的事；要在白板上看见，就让它用 open_terminals 开成终端（N2）。
- **实际情况**：用户实测：让 claude 并行查 5 件事时，它用的是自带的后台 agent，窗口组没出现，只在主终端底部列了 5 行。本机 claude 2.1.291 核对：有 SubagentStart / SubagentStop 钩子；每个子 agent 在 <会话 id>/subagents/ 下有 agent-<id>.jsonl（记录，isSidechain、agentId）和 agent-<id>.meta.json（agentType、description、toolUseId、requestShape: background）。codex、pi、omp、kimi 有没有子 agent、记在哪里还没查。实现时（2026-10-26，真 claude 跑过）又发现：后台 agent 做完时 claude 用 UserPromptSubmit 给主 agent 发 <task-notification>（带 status、subagent_tokens、duration_ms），所以这个钩子不一定是用户发的消息；claude 自己的内部查询每轮会单独发一两个没有 Start、没有 agent_type 的 SubagentStop，不能列出来；Stop / SubagentStop 的负载带 background_tasks（带任务描述）。我们算的 token 和 claude 自己列表里的一致（27.1k）。
- **怎么验证**：2026-10-26 用户定（画板 13，N10）：用钩子和记录读出来。平时只在主终端底边右侧挂一个小提示，有后台 agent 才出现；点开是 N2 的同一列侧边栏，后台 agent 单独一组，选中看它的记录，只读，不能打字、批准、停止。先做 claude，其他 agent 调研后再定，读不到的不显示。

<a id="dr-62"></a>

### DR-62 各 agent 的历史会话存在哪、怎么列出来

状态：待验证 · 出处：v3 N11 · 设计画布画板 14 · packages/agent-adapters（会话列表）· 新的 ui/panels/history · 旧编号 —

相关：IS-86

- **原来以为**：（N11 之前没考虑过：白板只管开着的终端）
- **实际情况**：已知的（做 Usage 时找文件的代码 packages/agent-adapters/src/usage/locate.ts）：claude 在 ~/.claude/projects/<目录名>/<id>.jsonl，每行带 cwd、gitBranch；codex 在 ~/.codex/sessions/年/月/日/rollout-*.jsonl，session_meta 带 cwd；pi、omp 有 sessions 目录；kimi 新建会话没有 id。待核对：标题字段（claude 的 summary 行、codex 的 thread 名）、每个文件只读开头和结尾能不能拿到第一条消息和最后活动时间、几千个文件第一次扫要多久、子 agent 和子任务的记录怎么排除、各 agent 的接回参数能不能按 id 接回在别的目录开的会话。
- **怎么验证**：2026-10-26 用户定（画板 14，N11）：左边栏按项目 → 工作路径 → agent 列出，只读各 agent 自己的文件，第一次扫一遍、之后按修改时间增量更新。具体字段实现前逐个 agent 核对，写回这一条。

<a id="dr-42"></a>

### DR-42 claude 能不能把对话 fork 到另一个目录

状态：已解决 · 出处：P1 · X4 · 旧编号 F1

- **原来以为**：claude --resume <id> --fork-session 在任何目录都能用。
- **实际情况**：2026-10-25 实测（X4）：claude 2.1.291 在另一个目录用 --resume <id> --fork-session 能接上原对话，副本写在新目录对应的 projects 文件夹里，原文件不变；codex 0.164 能 fork，但 TUI 不加 -C 会先弹框、默认用原目录；pi 0.83 的 --fork 先找本目录、再找所有目录；omp 18.0.4 能找到并复制（TUI 没核对）；kimi 要两步，先不支持。claude、pi、omp 只有在第一条消息之后才写会话文件，对没说过话的会话 fork 会报 No conversation found 退出。
- **决策**：不用复制记录：claude 直接 --resume --fork-session，codex 用 fork -C <目录> <id>，pi / omp 用 --fork；fork 前先找会话文件，没有就提示先发一条消息，不开终端；kimi 灰掉。
- **好处**：换框、换分支时带着原来的上下文，原对话不受影响。
- **代价**：omp 的 TUI 没在真终端里核对；kimi 暂不支持。

<a id="dr-43"></a>

### DR-43 Approve all 发的“允许一次”按键对不对

状态：待验证 · 出处：线 1、P1 · X3 · 旧编号 F2

相关：TC-05、IS-12

- **原来以为**：claude 按回车、codex 按 y 就是“允许一次”。
- **实际情况**：各家确认界面的默认选项和按键可能变，选错了会变成“以后都允许”。
- **怎么验证**：线 1 用真终端核对后写进适配器；核对不过的 agent 不提供 Approve all。

<a id="dr-44"></a>

### DR-44 经过 tmux 后的手感，要人在真界面上确认

状态：待验证 · 出处：packages/tmux-host/AGENTS.md「需要人工确认」 · 旧编号 F3

相关：IS-05

- **原来以为**：自动测试能覆盖终端手感。
- **实际情况**：F7 能自动测的都通过了，但有 9 项只能人看：颜色和框线字符、真实键盘上 Esc / Shift+Enter / 多行粘贴、触控板滚动和回滚、拖选复制、和系统终端同时接上、claude 的完成提醒、tmux 3.5 上加载配置。
- **怎么验证**：线 1 做出终端窗口后，按 packages/tmux-host/AGENTS.md 里的清单请用户逐项试。

