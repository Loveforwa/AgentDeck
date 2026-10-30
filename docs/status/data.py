# 验收报告的数据（用例和问题在 tracking.py，调研在 ../research/entries.py，做完的任务在 done.py）。FEATURES、SMOKE 的旧行、P0 是 2026-10-23 晚 v1 的快照。改这里，然后运行 `python3 docs/status/build.py`。
# 证据来自：各包测试、组装时记下的问题（已并进 tracking.py 的问题清单）、提交 3c42908 的说明、shots/ 下的截图，
# 以及当晚在 main（372434a）上重跑的 pnpm check 和两次 Electron 启动。

DATE = '2026-10-29'
COMMIT = '5246c6e'

# 已完成的需求（2026-10-29 从设计画布和任务表沉淀过来）。canvas 是设计画布里归档的那一页
DONE_GROUPS = [
    dict(key='base', title='基础：白板、终端、工作区和 Git、状态提醒、网页窗口', ms=['M0', 'M1', 'M2', 'M3', 'M4'], when='v1 · 2026-10-23～25',
         canvas='已完成 · 基础需求 · 流程（画板 0–10）',
         summary='一整块白板上放 tmux 托管的真终端，每个框是一个工作区（worktree + 分支），右侧源代码管理面板跟着聚焦的窗口走；'
                 'claude、codex 的状态来自它们自己的钩子，在等你的窗口一眼看得出、⌘J 跳过去；终端里的 localhost 链接在同一个框里开网页窗口。'
                 '关掉应用 agent 继续跑，重开原样接回。具体能做什么见下面“已经实现的基础功能”。'),
    dict(key='v2', title='v2：少占地方、互不遮挡、一眼看出状态', ms=['M5'], when='2026-10-24 第一轮验收后',
         canvas='已完成 · v2 · v3（画板 11）',
         summary='顶栏并进系统标题栏；颜色只表达状态（运行中绿、等你黄、出错红）；拖动窗口、改框大小时有对齐线，框不重叠；'
                 '左边 BOARD 列表单击跳到窗口。'),
    dict(key='v3', title='v3：agent 指挥白板、子 agent、提交图、后台 agent、历史会话、项目框排版', ms=['M6'], when='2026-10-25～27',
         canvas='已完成 · v2 · v3（画板 12–15）',
         summary='白板上的 agent 通过 AgentDeck 的 MCP 开窗口、读别的终端；子 agent 窗口成组；源代码管理面板有提交图；'
                 'claude 的后台 agent 在主终端底边一个小提示，点开只读查看（N10 目前只认 claude）；左边栏按工作路径再按 agent 列历史会话，'
                 '没开着的点 Resume 接回；项目框一键排版（Tidy / Columns / Rows），新建时自动排。'),
    dict(key='plugins', title='插件：Auto-approve、Usage、Auto-resume', ms=['M7'], when='2026-10-25～28',
         canvas='已完成 · 插件（PL0、PL1、PL2、PL4）',
         summary='插件能贴在白板、框、终端上，规矩统一（终端单独的设置优先）。Auto-approve 替你按“允许一次”，红色书签；'
                 'Usage 在终端上方一条显示 token 和额度；Auto-resume 在撞上额度的终端上挂书签，恢复后替你续跑，续跑的话能改。'
                 'PL3 Prompt queue 2026-10-28 试用后退役，剩下的并进 Auto-resume。还没做的 PL7（收件箱里的 Usage limit，等 CR1）和 PL9（omp、pi、kimi 撞额度的调研）在任务表。',
         retired=['PL3']),
    dict(key='early', title='高级需求里先做完的任务（第 0、1 波）', ms=['M8', 'M9', 'M10', 'M11', 'M15', 'M18', 'M19'], when='2026-10-28 · integrate/W0-W1',
         canvas='各高级需求的页（需求本身还没做完，仍在画布上）',
         summary='这些需求整体还在设计画布和任务表里，只是先做完了地基和几项能直接用的：各需求的 contracts、Session 表和 SessionService、'
                 '每家 agent 都送得到第一条消息、适配器合格测试和按 compat 降级、MCP 收紧（不往等你的终端里打字、Hide from agents、遮掉密码）、'
                 'agentdeck 命令行和每个终端一把钥匙、git 的 blame 和 worktree 重叠计算、doc-service、Send selection to ▸、BOARD 的 Agents 视图、清理旧的 skill-sets 目录；'
                 '还有 CR12、AH5、DC11 三项实测。'),
]

# 架构（原《实施方案》2026-10-23 里仍然成立的部分，2026-10-29 按现在的代码改写）
ARCH_STACK = [
    ('桌面外壳', 'Electron + electron-vite', '主进程能改写 localhost 的响应头，网页窗口才能嵌进白板；xterm.js 是最成熟的终端组件。只支持 macOS 和 Linux（tmux 没有原生 Windows 版）。'),
    ('仓库', 'TypeScript，pnpm 单仓多包', '每个模块一个包，边界清楚，agent 好分工。'),
    ('界面', 'React 18 + Zustand，白板用 React Flow（@xyflow/react）', '节点就是普通 React 组件，自带平移缩放、拖角缩放和分组节点。'),
    ('终端进程', 'AgentDeck 自己的 tmux 实例（tmux -L agentdeck）', '关掉应用 agent 继续跑，重开直接接上，历史输出由 tmux 保存；你也能在自己的终端里 tmux attach。'),
    ('终端显示', 'xterm.js，连接放在 utilityProcess（tmux-host）', '只为视口里的终端接上显示，移出就断开；出问题不拖垮界面。'),
    ('Git', '直接调系统 git，不监听文件', '只在切换聚焦、agent 一轮结束、你自己操作之后刷新。'),
    ('本地数据', 'SQLite（better-sqlite3，packages/store）', '白板布局、终端对应的 tmux 会话、Session 记录；终端历史由 tmux 保存。'),
    ('网页窗口', 'iframe + 主进程去掉 localhost 的 X-Frame-Options / frame-ancestors；本地文件走自定义协议', '能跟着白板一起缩放。'),
    ('agent 状态', 'agent 自带的钩子（启动时临时注入，不改你的配置），没有钩子的看 tmux 的输出活动', '比正则匹配输出准，各家 TUI 改版也不怕。'),
    ('测试和边界', 'Vitest + Playwright（Electron 模式）；dependency-cruiser', 'pnpm check 跑类型、lint、颜色、模块边界和全部单元测试；pnpm e2e 驱动真应用。'),
]
ARCH_FLOW = [
    '界面进程（React）只负责显示和交互：白板、窗口（终端、网页）、面板（源代码管理、历史会话、BOARD），通过 window.agentdeck 的类型化 IPC 调主进程。',
    '主进程（apps/desktop）只做组装：把各服务接起来、改写响应头、提供自定义协议、接收 agent 钩子的本地回调端口、跑 AgentDeck 的 MCP 服务。',
    'tmux-host 在独立的 utilityProcess 里管 AgentDeck 自己的 tmux 实例；agent 进程跑在 tmux 里，不在 AgentDeck 的任何进程里。',
    '服务包（git-service、workspace-service、agent-adapters、port-watch、store、mcp-server、doc-service）只被主进程用；界面不碰服务，服务不碰界面。',
]
ARCH_PACKAGES = [
    ('contracts', '模块之间唯一的约定（接口、IPC 消息、事件），改它要单独提交、只加不删（现在 0.1.23）'),
    ('design-tokens', '颜色、字号、间距、圆角；界面上的样子只在这里定'),
    ('tmux-host', 'AgentDeck 自己的 tmux 实例：会话、显示、最后几行、输出抄送'),
    ('agent-adapters', '每个 agent 一个适配器：启动、钩子、状态机、用量、额度（limits）、Session、Skill'),
    ('git-service / workspace-service', 'git 操作；工作区 = 仓库 + worktree + 分支'),
    ('port-watch', '从终端输出里找 localhost 地址'),
    ('store', 'SQLite 和迁移'),
    ('mcp-server', '给白板上的 agent 用的 MCP 和 agentdeck 命令行的 /cli 入口'),
    ('doc-service', '文档的底层（DC2）'),
    ('ui/canvas', '白板、框、右键菜单、设置、插件（plugins/）'),
    ('ui/window-shell、ui/topbar、ui/kit', '窗口外框、顶栏、基础零件'),
    ('ui/widgets/terminal、ui/widgets/browser', '终端窗口、网页窗口'),
    ('ui/panels/scm、history、board-nav', '源代码管理面板、历史会话、BOARD 列表'),
    ('tools/fakes', '每个服务的假实现，界面和服务可以各自单独开发和测试'),
    ('tools/agentdeck-cli、agentdeck-notify', 'agentdeck 命令行；钩子回调的小程序'),
]
ARCH_RULES = [
    '只通过 contracts 通信：界面和服务都只认它，换掉一个服务的实现，界面一行不动。',
    '注册表代替 if/else：窗口类型、agent、插件都通过注册表接入，加一种就是加一个文件夹再加一行注册。',
    '数据单向流动：服务发事件，store 更新，组件只读 store；组件之间不互相调用。',
    '依赖方向写成规则：dependency-cruiser 在 pnpm check 和 CI 里检查，规则表在 AGENTS.md「检查和模块边界」。',
    '每个服务自带假实现，每个包一份 AGENTS.md（职责、对外接口、不许碰的目录、怎么跑测试）。',
]

# 已经实现的基础功能，按用户能看到的东西分组
FEATURES = [
    ('白板和窗口', [
        '一整块可平移、⌘ + 滚轮缩放的白板，点阵背景；⌘0 / ⌘1 缩放到 100% / 显示全部',
        '窗口外框：拖标题栏移动、拖边和角改大小、放大还原、关闭、聚焦描边、层级',
        '右键菜单：New terminal ▸（列出已安装的 agent）、New browser、New workspace…、Add project…',
        '顶栏：白板名、“n running · n waiting”、Projects ▾、在等你的按钮',
        '布局改动后半秒自动保存，重开应用原样恢复',
        '终端拉小到 320×200 以下变摘要卡（最后 3 行和状态），单击恢复',
    ]),
    ('终端（tmux 托管）', [
        '所有终端跑在 AgentDeck 自己的 tmux 实例里，关掉或退出应用后继续运行，重开自动接回，历史输出都在',
        '只为视口里的终端接上显示，移出就断开',
        '按键直通：不带 ⌘ 的按键全部交给终端；Shift+Enter、多行粘贴、拖入文件路径',
        '进程退出显示 Exited / Error 和 Restart；命令找不到有提示',
        '输出里的 localhost 地址和“文件:行号”可以点',
        'agent 用登录 shell 的环境启动（拿得到 PATH 和代理变量），claude 在 tmux 里保持真彩色',
    ]),
    ('项目、工作区和 Git', [
        '添加项目（自动用仓库根目录、识别基础分支），项目可以是一个仓库、多个仓库或没有 git 的文件夹',
        '新建工作区：新 worktree + 新分支或已有分支，或主目录工作区；复制 .env；自动运行初始化命令；失败回滚',
        '工作区框：标题是“项目 · 分支”，拖标题带走里面的窗口；框里新开的终端在工作区目录',
        '删除工作区：只从白板移除，或连目录一起删；有未提交的改动要再确认',
        '右侧源代码管理面板跟随聚焦的窗口：树形更改、暂存 / 取消暂存、提交（⌘↩）、切换分支（被占用的灰显）、stash 往返、提交记录',
        'Git 不监听文件，只在切换聚焦、agent 一轮结束、自己操作之后刷新',
    ]),
    ('agent 状态和提醒', [
        'claude、codex 的状态来自它们自己的钩子（启动时临时注入，不改你的配置），其他程序看输出活动',
        '标题栏状态点和文字：Running · 4m、Needs approval、Needs reply、Idle、Exited、Error',
        '在等你的窗口：橙色边框、框标题和顶栏显示“1 waiting”，⌘J 依次跳过去',
        '应用在后台时：系统通知和程序坞角标',
    ]),
    ('网页窗口', [
        '在白板上打开网页，地址栏、后退、刷新、在系统浏览器打开',
        '单击终端里的 localhost 链接，网页窗口出现在终端旁边、同一个框里；同一地址已开着就聚焦它',
        '本地页面能嵌进来（主进程改响应头），服务端写的登录 cookie 能用；服务没起来时显示出错页和 Retry',
    ]),
    ('工程基础', [
        'pnpm check：类型检查、代码规范、界面不许写颜色、15 条模块边界规则、所有测试',
        '所有服务都有假实现，各条线可以单独开发和演示',
        'contracts 0.1.3：模块之间唯一的约定，并行开发期间只加不改',
        '演示和截图模式：AGENTDECK_DEMO=1、AGENTDECK_SCREENSHOT=<路径>',
    ]),
]

# 烟测（前两行是 2026-10-29 合进 main 后在 main 上跑的，其余是 2026-10-23 晚 v1 的）
SMOKE = [
    ('pnpm check（main，2026-10-29）', 'ok', '合并后在 main（代码同 integrate/W0-W1 5246c6e）上：类型检查、ESLint、颜色检查、模块边界全部通过；Vitest 1982 个通过、115 个跳过（122 个测试文件通过、4 个跳过）。'),
    ('端到端 pnpm e2e（main，2026-10-29）', 'ok', '全量 92 条：89 条通过、3 条跳过（要开 AGENTDECK_E2E_PERF=1 的性能项），约 11.6 分钟；3 条已知缺口照旧写成 test.fail。'),
    ('pnpm check（main，372434a）', 'ok', '类型检查、ESLint、颜色检查、模块边界全部通过；Vitest 719 个通过、4 个跳过（需要真 agent 的那 4 个）。其中约 15 个用真 tmux、约 68 个用真 git 临时仓库。'),
    ('演示模式启动（AGENTDECK_DEMO=1）', 'ok', '在 main 上启动 Electron：自动加本仓库为项目、建主目录工作区、开 zsh 和 claude 两个真终端，2 个终端都有输出后截图并正常退出。'),
    ('退出后重开', 'ok', '不带演示模式再启动一次：框、两个窗口位置不变，tmux 里的会话还在，历史输出完整接回。'),
    ('真 claude / codex 测试（AGENTDECK_REAL_AGENTS=1）', 'skip', '今晚没跑：它会自动回答 codex 的“信任这个文件夹”，往你的 codex 配置里写记录，需要你同意。线 4 开发时跑过两次，都通过。'),
    ('端到端（Playwright）', 'ok', 'pnpm e2e（R2）：9 条验收用例 + 2 条已知缺口，本机约 55 秒全过；每个测试单独的数据目录、tmux 和 HOME，agent 用假 claude。见 e2e/AGENTS.md。'),
    ('GitHub Actions', 'none', '仓库没推送，没跑过；而且工作流里没装 tmux，真 tmux 的测试在 CI 上会被跳过。'),
]

# v1 的 39 项基础功能（P0）
# status: auto 完成且有自动测试 / manual 完成但只有手动或组装验证 / partial 部分完成或未做
P0 = [
    ('F1', '单仓骨架', 'manual', '只有 pnpm check', 'pnpm dev 能打开窗口', ''),
    ('F2', 'contracts', 'auto', '类型检查 + 假实现的接口测试', '各包接进应用后编译通过', '当前 0.1.3'),
    ('F3', 'IPC 层', 'auto', '34 例（路由、错误还原、preload）', '真 IPC 在用', '“统一超时包装”没找到'),
    ('F4', 'tokens 和零件', 'auto', '46 例（含禁止写死颜色）', '有演示页', ''),
    ('F5', 'CI 和模块边界', 'auto', '每条规则有违规样例', '—', 'CI 没在云端跑过'),
    ('F6', '假实现', 'auto', '74 例', '各演示页都用它', ''),
    ('F7', 'tmux 配置试验', 'manual', '真 tmux 测试加载了这份配置', '试验脚本 + 测量数据', '9 项需要人工确认，都还没勾'),
    ('F8', '本地存储', 'auto', '38 例（真 SQLite）', '开发数据库已生成', ''),
    ('B1', '白板画布', 'partial', '没有手势测试（jsdom 测不了）', 'dev 页手动试过', '“30 个窗口平移不掉帧”没测量'),
    ('B2', '窗口外框', 'partial', '16 例', '截图里外框正常', '完成标准要的 Playwright 用例没有'),
    ('B3', '窗口注册表和右键菜单', 'auto', '9 例', '右键菜单出现', '菜单里多一个 custom，应用里先藏了'),
    ('B4', '顶栏', 'auto', '数字随事件变', '“1 waiting”出现过', ''),
    ('B5', '布局自动保存', 'auto', '自动保存、重启恢复、存储往返', '⌘Q 后重开一样', '没测强杀进程'),
    ('T1', 'tmux-host 服务', 'auto', '25 例，15 例真 tmux', '跑在 utilityProcess，退出后会话还在', ''),
    ('T2', '终端窗口显示', 'auto', '30 例（含真 xterm 解析）', '两个真终端正常显示', '在 Electron 里的打字延迟没测（tmux-host 层 p99 < 50ms）'),
    ('T3', '输入、复制、粘贴', 'auto', '按键决策、Shift+Enter、拖入路径', '—', '真键盘在 Electron 里没试'),
    ('T4', 'agent 适配器', 'auto', '30 例 + 4 例真 agent', '检测到 claude 和 codex', ''),
    ('T5', '退出、出错、重启', 'auto', '退出、关闭确认、系统终端命令', '—', 'Open in system terminal 没真点'),
    ('T6', '重开应用自动接上', 'auto', '真 tmux 接管 + 窗口重连', '重开截图，输出都在', '重开后状态时间从“现在”算'),
    ('T7', '链接识别', 'auto', '12 组用例', '组装时点 http.server 的链接开了网页窗口', ''),
    ('T8', '摘要卡', 'auto', '变摘要卡、恢复并聚焦、真 tmux 取最后几行', '—', 'Electron 里拉小再恢复没验证'),
    ('W1', '项目', 'partial', '9 例真 git + 选文件夹流程', '只用演示模式加过项目', '没有 Settings › Projects 界面，Settings 打开的是 settings.json'),
    ('W2', '新建工作区', 'auto', '8 例真 git（新分支、复制 .env、回滚、分支被占用）', '—', 'Electron 里没建过 worktree'),
    ('W3', '工作区框', 'auto', '框里终端目录、拖框带窗口', '主目录工作区的框正常', 'worktree 框没在 Electron 里看过'),
    ('W4', '删除工作区', 'auto', '6 例真 git（有改动要强删、分支保留）', '—', ''),
    ('W5', '终端换框的限制', 'auto', '弹回和 Open new', '—', ''),
    ('G1', 'git-service', 'auto', '49 例，41 例真 git', '面板显示真实状态', ''),
    ('G2', '源代码管理面板', 'auto', '18 例', '暂存和取消暂存试过', 'Electron 里没真提交'),
    ('G3', '切换分支', 'auto', '灰显、跳转、stash；9 例真 git', '—', '跳到别的框没试'),
    ('G4', '刷新时机', 'auto', '数刷新次数', '—', '“空闲 CPU 接近 0”没测量'),
    ('S1', '钩子接收', 'auto', '18 例（100ms 内到达）+ 真 agent', '手动发批准请求和 Stop，一路到标题栏', ''),
    ('S2', '状态机', 'auto', '40 例，状态表每行一例', 'Idle、Needs approval 都显示过', 'claude 停在信任提示时显示 Idle'),
    ('S3', '界面提醒', 'auto', '橙色、计数、⌘J', '橙色、“1 waiting”、角标都出现了', '“2 秒内”没计时'),
    ('S4', '后台通知', 'auto', '通知规则 6 例', '角标出现', '点系统通知没试'),
    ('U1', '网页窗口', 'auto', '73 例（响应头改写、服务、组件）', '组装时开过', ''),
    ('U2', '从终端打开网页', 'auto', '复用和打开位置', '组装时开过', ''),
    ('U3', '出错页和本地文件', 'auto', '15 例', '试验脚本', ''),
    ('R1', '快捷键', 'auto', '快捷键分发 + 菜单', '菜单项触发 ⌘B ⌘W', '真键盘在网页里没试'),
    ('R2', '端到端验收', 'auto', 'e2e/：Playwright Electron 模式 9 条（TC-01 TC-02 TC-05 TC-06 TC-07 TC-09 TC-10 TC-12 TC-30）+ 2 条已知缺口（test.fail）；隔离的数据目录、tmux、HOME，假 claude 发真钩子', '本机 pnpm e2e 11 条全过，约 55 秒', 'CI（.github/workflows/e2e.yml）没跑过：仓库没有远端；TC-03 TC-04 TC-08 TC-11 TC-13 TC-14 没写'),
]

# 14 条验收场景（来自设计画布「10 · 全局规则」），编号就是端到端用例 TC-01 到 TC-14



# 明天验货的步骤
TRY = [
    ('启动', 'cd /Users/liu/2026/agenduck && git switch main && pnpm install && pnpm dev', '主目录现在停在 feat/PL3-prompt-queue，上面有没提交的 PL3 改动（已退役，备份过），切 main 之前先决定丢掉还是留着。开发数据在 .agentdeck-dev/，不碰你真实的 ~/.agentdeck。'),
    ('看在等你的提醒', '让 claude 运行一个需要批准的命令', '窗口、框、顶栏一起变黄，⌘J 跳过去；切到别的应用会收到系统通知。'),
    ('新建一个工作区', '右键 › New workspace…，基于 main 新建一个分支', '框出现，里面开的终端在新 worktree 里；右侧面板显示这个分支。'),
    ('网页窗口', '在 Shell 里运行 python3 -m http.server 8765，点输出里的地址', '网页窗口出现在终端旁边、同一个框里。'),
    ('插件', '右键终端 › Auto-approve / Usage；右键白板空白处 › Auto-resume', '书签挂在终端底边，Usage 条在终端上方。'),
    ('退出再打开', '⌘Q，再 pnpm dev', '框和窗口位置不变，终端还在跑，输出都在。'),
]

NEXT = [
    '用审查台（https://claude.ai/artifact/ChBaxMte5BCt6RQJPCus4s）审还没做的高级需求和这份报告；审完我按结果统一整改，标“不做”的需求从设计画布和任务表删掉。',
    '决定主目录里 feat/PL3-prompt-queue 上没提交的 PL3 改动（已退役）：丢掉还是留着；之后主目录切回 main。',
    '2026-10-29 main 推到了 GitHub。CI 的 e2e 第一次跑红了：Ubuntu 的 tmux 只有 3.4（e2e 改成只在 macOS 跑），macOS 机器屏幕 1024×768 窗口太小（e2e 固定 1440×900），brew 的 tmux 3.8 让 Esc 慢 500ms（IS-162，已修）。修好后 CI 的 e2e：86 条通过，TC-07 是测试自己的时序（已修），TC-26、TC-41 偶尔要重跑（IS-164）。',
    'TC-81 偶尔失败一次（重跑 9 次都过），还没查原因。',
    '下一波要做的任务见任务表：第一期是 CR1 收件箱（PL7 也等它）、Session 的界面（SE3–SE6）和 Agent 接入剩下的几项。',
]
