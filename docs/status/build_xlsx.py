# 生成 docs/status/AgentDeck-端到端用例与问题清单-<日期>.xlsx。用法：python3 docs/status/build_xlsx.py <输出路径>（需要 openpyxl）
import sys
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import FormulaRule

OUT = sys.argv[1]
FONT = 'Arial'

# ---------------- 端到端用例 ----------------
# 状态：⚠ 当前有问题 / 未验证 / 部分验证 / 已验证 / 未实现
CASES = [
    # ---- 当前有问题 ----
    dict(id='E24', p='P0', status='部分验证',
         scene='在面板里给“主目录工作区”切换分支',
         pre='主目录工作区的框里开着终端（空闲也算）；项目是一个普通测试仓库，不要用 agenduck 本身',
         steps='1. 聚焦框里的终端\n2. 面板里单击分支按钮\n3. 单击另一个分支',
         expect='UI：只要这个目录里有终端开着（不管 Running 还是 Idle），先弹确认，写明哪些终端在这个目录里、它们看到的文件会变；确认后才切换，框标题更新为新分支。\n后台：确认后才执行 git switch；切换后 workspace-service 更新记录并发 workspace.changed。',
         result='不会因为点错一下就把正在用的目录切到别的分支',
         issue='已修（925c11f）：只要目录里有终端开着就确认（Q38）；切 AgentDeck 自己运行的目录（agenduck）会被拒绝并提示（Q39）。在真窗口里用调试端口调用切分支已确认被拒绝；确认框请在一个测试仓库上点一遍验收。起因：2026-10-24 在 agenduck 的主目录工作区里单击分支，没确认就切到遗留分支，正在运行的 AgentDeck 热更新成旧代码',
         rel='Q38 Q39 Q31'),
    dict(id='E04', p='P0', status='⚠ 当前有问题',
         scene='agent 停下来请求批准时，用户一眼看出是谁在等',
         pre='框里有一个已信任文件夹的 claude；应用分别在前台、后台各试一次',
         steps='1. 让 claude 执行一个需要批准的命令（例如 “run ls in a new shell”）\n2. 不点任何东西，观察 2 秒\n3. 切到别的应用，再触发一次',
         expect='UI：2 秒内窗口出现橙色边框，标题栏状态 Needs approval，框标题和顶栏显示 “1 waiting”，程序坞角标 1；应用在后台时弹系统通知 “claude in … needs approval”。\n后台：claude 的 PermissionRequest 钩子经 agentdeck-notify 送到钩子 socket，状态机进入 needs-approval 并广播 status.changed。',
         result='不用盯着每个终端，也知道哪个 agent 在等你',
         issue='claude 还停在“信任这个文件夹”提示时，状态显示 Idle，不变橙（Q06）；真 claude 的批准请求从没端到端跑过（Q01）；系统通知没真弹过（Q14）',
         rel='Q01 Q06 Q14'),
    dict(id='E05', p='P0', status='⚠ 当前有问题',
         scene='跳到在等你的窗口，直接批准，agent 继续干活',
         pre='E04 的状态：有一个 claude 在 Needs approval',
         steps='1. 按 ⌘J\n2. 在终端里按 claude 的“允许一次”键\n3. 观察状态',
         expect='UI：白板平移到那个窗口并聚焦，橙色边框消失（状态点仍橙）；批准后状态变 Running，“1 waiting” 消失。\n后台：输入经 tmux-host 送进 claude；PostToolUse / 新输出让状态机回到 running。',
         result='从发现到批准一气呵成，不用找窗口',
         issue='需求写的是“直接按 y”，但 claude 实测“允许一次”是 1 或回车（线 1 核对），y 不确定能用，需要定需求（Q12）；批准后回到运行中没测过（Q01）',
         rel='Q01 Q12'),
    dict(id='E03', p='P0', status='⚠ 当前有问题',
         scene='同一个仓库开两个工作区，两个 claude 并行改代码互不影响',
         pre='已有项目，已建好 feat/oauth 工作区（E02）',
         steps='1. 再建一个 fix/rate-limit 工作区\n2. 两个框里各新开一个 claude，紧接着连续开\n3. 各让它改一个不同的文件',
         expect='UI：两个框各自显示自己的分支，两个 claude 都正常启动；右侧面板随聚焦切换，只显示各自 worktree 的改动。\n后台：两个 worktree 各有自己的 HEAD 和暂存区；两个 tmux 会话的工作目录分别是两个 worktree。',
         result='多个 agent 在同一仓库的不同分支上同时工作，改动不串',
         issue='连着新建两个终端时，第二个可能误显示 “Previous session ended”（Q07）；两个真 claude 并行从没试过（Q03）',
         rel='Q03 Q07'),
    dict(id='E10', p='P0', status='⚠ 当前有问题',
         scene='退出应用再打开，所有东西都还在',
         pre='白板上有框和至少两个终端，其中一个在跑',
         steps='1. ⌘Q 退出\n2. 再打开（pnpm dev）',
         expect='UI：框和窗口的位置、大小不变；终端接回，历史输出都在；状态和计时正确。\n后台：tmux 里的会话在应用退出期间一直在跑；重开时按保存的 terminalId 接回，状态机重新登记这些终端。',
         result='关应用不打断 agent 的工作',
         issue='接回后状态都显示 “Idle · now”，开始时间没接上（Q08）；强杀进程（不是 ⌘Q）后恢复没测过（Q27）。位置和输出 2026-10-23 已验证',
         rel='Q08 Q27'),
    dict(id='E02', p='P0', status='⚠ 当前有问题',
         scene='基于 main 新建一个分支工作区，开箱即用',
         pre='已添加项目（E01）；项目里有 .env；设置了初始化命令（例如 pnpm install）',
         steps='1. 右键 › New workspace…\n2. 选 New worktree、New branch，名字 feat/oauth，from main\n3. Create',
         expect='UI：框出现在右键的位置，标题 “项目 · feat/oauth”；框里自动开一个 Shell 运行初始化命令；右侧面板显示 feat/oauth。\n后台：git worktree add 建好目录并新建分支；.env 被复制过去；失败时已建的 worktree 和分支回滚。',
         result='一个新分支的独立工作目录准备好了，agent 可以直接进去干活',
         issue='从界面新建 worktree 在真窗口里从没走过（Q02）；开发模式下 worktree 放在 .agentdeck-dev 里借用的假主目录下，路径和正式版不同（Q19）',
         rel='Q02 Q19'),
    dict(id='E15', p='P1', status='⚠ 当前有问题',
         scene='修改项目设置：基础分支、复制的文件、初始化命令',
         pre='已添加项目',
         steps='1. 顶栏 Projects ▾ › Manage projects…（或 Settings › Projects）\n2. 改基础分支和初始化命令\n3. 新建一个工作区验证',
         expect='UI：有项目设置页，能看到并修改名称、路径、基础分支、worktree 位置、复制的文件、初始化命令。\n后台：设置写进 store，新建工作区时生效。',
         result='每个项目按自己的习惯建工作区',
         issue='没有 Settings 界面：点 Settings 只是用系统程序打开 settings.json，Settings › Projects 不存在（Q13）',
         rel='Q13'),
    dict(id='E16', p='P2', status='⚠ 当前有问题',
         scene='刚打开应用，右侧面板给出有用的信息',
         pre='白板上有一个工作区框，还没有聚焦任何窗口',
         steps='1. 打开应用，不点任何东西\n2. 单击框里的一个终端',
         expect='UI：没聚焦时提示怎么开始（例如 “Select a window to see its changes”）；聚焦后显示那个工作区的 git 状态。\n后台：面板只在聚焦变化时刷新一次。',
         result='面板不说让人困惑的话',
         issue='没聚焦任何窗口时也显示 “This window isn’t in a workspace.”（Q22，见重开截图）',
         rel='Q22'),
    dict(id='E17', p='P2', status='⚠ 当前有问题',
         scene='右键新建终端，菜单只列出能用的 agent',
         pre='本机装了 claude 和 codex',
         steps='1. 在白板空白处右键 › New terminal ▸',
         expect='UI：列出 Claude、Codex、Shell，用适配器的名字显示；没装的不出现；选中后在点击的位置开终端。\n后台：agents.list() 返回已安装的 agent。',
         result='菜单里每一项都能用',
         issue='白板按 agent id 而不是名字显示，并且会列出用不了的 custom；应用里先把 custom 藏掉了，白板包本身没改（Q21）',
         rel='Q21'),

    # ---- 未验证 / 部分验证 ----
    dict(id='E01', p='P0', status='未验证',
         scene='第一次打开应用，添加一个项目',
         pre='干净的数据目录（删掉 .agentdeck-dev 或设 AGENTDECK_DATA_DIR 到新目录）；有一个本地 git 仓库',
         steps='1. 在白板空白处右键 › Add project…\n2. 在系统的选文件夹窗口里选仓库（试一次选它的子文件夹）',
         expect='UI：系统选文件夹窗口出现；选完直接进入 New workspace 对话框，项目已选好；选子文件夹时提示用了仓库根目录。\n后台：projects 表多一条；基础分支自动识别为远端默认分支或 main。',
         result='加项目一步到位，直接进入建工作区',
         issue='流程有单测；组装时用的是演示模式自动加项目，真窗口里没点过',
         rel='Q02'),
    dict(id='E06', p='P1', status='部分验证',
         scene='在框里跑 dev server，点链接就在白板上看效果',
         pre='框里有一个 Shell 终端；项目能跑 pnpm dev（或用 python3 -m http.server 8765 代替）',
         steps='1. 在终端里运行 dev server\n2. 单击输出里的 localhost 地址\n3. 再单击一次同一个地址',
         expect='UI：网页窗口出现在终端右边、同一个框里，页面正常显示；第二次单击聚焦并刷新已开的窗口，不新开。\n后台：port-watch 从输出里识别出地址；主进程把这个来源加入响应头改写名单。',
         result='写代码和看效果在同一个框里',
         issue='组装时用 python http.server 点开过网页窗口；真 pnpm dev 和“第二次点击复用”没在真窗口里试',
         rel=''),
    dict(id='E07', p='P0', status='部分验证',
         scene='在右侧面板里提交 agent 改的代码',
         pre='某个工作区里有几个改动的文件；用一个测试分支，不要在 main 上提交',
         steps='1. 聚焦那个工作区里的终端\n2. 悬停文件单击 + 暂存两个\n3. 写提交信息，按 ⌘↩',
         expect='UI：面板显示这个分支的更改，按文件夹树形排列；暂存后进 Staged Changes；提交后列表清空一部分，提交记录顶部出现这一条。\n后台：git add / git commit 在这个 worktree 里执行；提交后面板再刷新一次 status。',
         result='不离开白板完成提交',
         issue='暂存和取消暂存在真窗口里试过；真的提交没做（为了不改 main）',
         rel=''),
    dict(id='E08', p='P2', status='未验证',
         scene='想切到已被别的工作区占用的分支时，直接跳过去',
         pre='同一仓库有 feat/oauth 和 fix/rate-limit 两个工作区（E03）',
         steps='1. 聚焦 feat/oauth 里的终端\n2. 面板里单击分支按钮\n3. 单击灰显的 fix/rate-limit',
         expect='UI：fix/rate-limit 灰显并写着 “in fix/rate-limit”；单击后白板平移到那个框并聚焦。\n后台：分支列表来自 git worktree list；不执行任何 git 操作。',
         result='不会因为分支被占用而切换失败',
         issue='面板有单测；需要第二个 worktree，组装时没试',
         rel='Q25'),
    dict(id='E09', p='P2', status='部分验证',
         scene='把终端拉小成摘要卡，腾出地方',
         pre='框里有两个在跑的终端',
         steps='1. 把两个终端的右下角往里拉到很小\n2. 单击其中一个摘要卡',
         expect='UI：小于 320×200 时变成摘要卡，显示最后 3 行和状态，在等你的仍是橙色；单击恢复到拉小之前的大小并聚焦，画面不乱。\n后台：摘要卡用 capture-pane 取最后几行，不 attach；恢复时重新 attach。',
         result='一屏放下更多 agent，又不丢信息',
         issue='白板和终端窗口都有单测；真窗口里没拉过',
         rel='Q23'),
    dict(id='E11', p='P2', status='未验证',
         scene='在系统终端里接上同一个 agent 会话',
         pre='有一个在跑的 claude 终端',
         steps='1. 标题栏右键 › Open in system terminal\n2. 在两边各输入几个字',
         expect='UI：系统终端打开并显示同一个会话；两边的输入和输出同步。\n后台：执行 tmux -L agentdeck attach-session -t <id>。',
         result='需要时可以用自己习惯的终端接着干',
         issue='命令拼装有单测；组装时没真点（会打开别的应用）',
         rel='Q15'),
    dict(id='E12', p='P1', status='部分验证',
         scene='删除工作区，连目录一起删',
         pre='一个 worktree 工作区，里面有一个未提交的改动；用测试分支',
         steps='1. 右键框 › Delete workspace…\n2. 选 Also delete the worktree folder\n3. 确认；看到“有未提交的更改”再确认一次',
         expect='UI：第一次确认后提示有未提交的更改，必须再确认；完成后框从白板消失。\n后台：git worktree remove --force；目录从磁盘消失，分支保留。',
         result='清理干净，又不会误删还没提交的工作',
         issue='服务层有真 git 测试；真窗口里没走过。会删目录，要在测试仓库上试',
         rel='Q24'),
    dict(id='E13', p='P1', status='部分验证',
         scene='关掉窗口，agent 在后台继续，需要时通知你',
         pre='有一个在跑的 claude',
         steps='1. 单击窗口的关闭按钮（不是 ⌘Q）\n2. 等 claude 请求批准\n3. 单击系统通知',
         expect='UI：窗口消失，应用留在程序坞；有批准请求时弹系统通知、角标变 1；单击通知窗口回来并跳到那个终端。\n后台：界面销毁但主进程和 tmux 连接还在；钩子照常到达。',
         result='关窗口不等于停工',
         issue='关窗口后台继续、点程序坞图标回来在真窗口里试过；点系统通知没试',
         rel='Q14'),
    dict(id='E18', p='P1', status='部分验证',
         scene='焦点在网页窗口里时，应用快捷键照样能用',
         pre='白板上有一个网页窗口和一个终端',
         steps='1. 单击网页内容\n2. 用真键盘按 ⌘J、⌘B、⌘W、⌘0、⌘1\n3. 在网页里按 ⌘R',
         expect='UI：⌘J / ⌘B / ⌘W / ⌘0 / ⌘1 照常生效；⌘R 只刷新这个网页，不重载整个应用。\n后台：快捷键注册成应用菜单的 accelerator。',
         result='不管焦点在哪，快捷键行为一致',
         issue='只用菜单项触发过 ⌘B、⌘W；真键盘没试',
         rel='Q16'),
    dict(id='E19', p='P1', status='未验证',
         scene='没装 tmux 或版本太低时给出明确的指引',
         pre='临时把 PATH 里的 tmux 去掉，或用一个低于 3.5 的 tmux',
         steps='1. 启动应用\n2. 按提示安装后点 Retry',
         expect='UI：显示说明页，写明需要 tmux ≥ 3.5 和 brew install tmux，有 Retry；装好后 Retry 能起来。\n后台：启动时检查 tmux -V；低于 3.5 抛 tmux-unavailable。',
         result='第一次用的人知道该做什么',
         issue='版本检查有单测；说明页在真窗口里没看过',
         rel=''),
    dict(id='E20', p='P1', status='未验证',
         scene='从程序坞打开应用，agent 照样能联网、能登录',
         pre='需要打包好的应用（现在还没有打包流程）',
         steps='1. 从程序坞或访达打开 AgentDeck\n2. 新开一个 claude，发一句话',
         expect='UI：claude 正常回答，不出现 403 或找不到命令。\n后台：启动时读登录 shell 的环境（PATH、代理变量），传给 tmux-host 和适配器。',
         result='不管从哪里打开，体验都和终端里一样',
         issue='只从终端里 pnpm dev 启动过，那时环境本来就是全的；从程序坞启动要等有打包版本（Q11、Q37）',
         rel='Q11 Q37'),

    # ---- 已验证 ----
    dict(id='E21', p='P0', status='已验证',
         scene='右键在白板上开一个终端并使用',
         pre='应用已打开',
         steps='1. 空白处右键 › New terminal ▸ Shell\n2. 输入 git status',
         expect='UI：在点击的位置出现终端，散放的终端在 ~ 运行；输出正常显示，状态 Running 后变 Idle。\n后台：tmux 里新建会话，窗格带 AGENTDECK_TERM；输出经 MessagePort 直达界面。',
         result='白板上直接用真终端',
         issue='2026-10-23 组装时验证',
         rel=''),
    dict(id='E22', p='P1', status='已验证',
         scene='关闭运行中的终端会结束进程',
         pre='有一个在跑的终端',
         steps='1. 单击标题栏的关闭\n2. 在确认框里选结束并关闭',
         expect='UI：先弹确认；确认后窗口消失。\n后台：tmux 会话被结束。',
         result='关窗口不会留下看不见的进程',
         issue='2026-10-23 组装时验证',
         rel=''),
    dict(id='E23', p='P1', status='已验证',
         scene='在面板里暂存再取消暂存一个文件',
         pre='工作区里有一个改动',
         steps='1. 单击文件旁的 +\n2. 再单击 −',
         expect='UI：文件在 Changes 和 Staged Changes 之间移动。\n后台：git add / git restore --staged；git status 和界面一致。',
         result='暂存操作和命令行一致',
         issue='2026-10-23 组装时验证（两次都对照了 git status）',
         rel=''),

    # ---- 未实现（P1 功能）----
    dict(id='E14', p='P2', status='未实现',
         scene='重启电脑后恢复上次的工作区和 agent 对话',
         pre='电脑重启过（或 tmux kill-server 模拟）',
         steps='1. 打开应用\n2. 在 “Restore your last session?” 里选 Restore all',
         expect='UI：弹出恢复提示；恢复后工作区和窗口在原位，claude 接回原来的对话，Shell 在原目录打开并填好命令。\n后台：按记录的会话 id 运行 claude --resume <id>、codex resume <id>。',
         result='重启不丢上下文',
         issue='属于 MVP 完整版（M4 · X6），还没做',
         rel='Q36'),
]

# ---------------- 问题清单 ----------------
# 类型：缺陷 / 未验证 / 缺失 / 需求不一致 / 技术债 / 清理
ISSUES = [
    ('Q38', 'P0', '缺陷', '源代码管理面板 · 白板', '在面板里单击分支会立刻切换，不确认：只有在有未提交改动或有 Running 的 agent 时才弹框；框里的终端是 Idle 时直接切。空闲的 agent 和 Shell 也在这个目录里，切分支会改掉它们眼前的文件', '主目录工作区里开一个 Idle 的终端，在面板里单击另一个分支', '误点一下就切走正在用的目录；2026-10-24 验收时实际发生', '只要这个目录里有任何终端开着就先确认（白板把框里所有活着的终端传给面板，不只 Running 的）；确认框写清会受影响的终端', 'E24'),
    ('Q39', 'P0', '开发风险', 'apps/desktop · 开发流程', '用 AgentDeck 管理 agenduck 仓库自己时，切换主目录的分支会改掉正在运行的 AgentDeck 的源代码，开发服务器热更新成旧代码，界面直接坏掉', '在 agenduck 自己的主目录工作区里切到任何旧分支', '验收和自举开发时很容易误伤；恢复要手动 git switch main 再重启', '短期：验收用别的测试仓库，或在独立 worktree 里跑 pnpm dev；长期：应用检测到要切的目录就是自己运行的目录时拒绝并提示', 'E24'),
    ('Q01', 'P0', '未验证', 'agent-adapters · 整体', '真 claude 的完整一轮从没在应用里跑通：信任提示之后的 SessionStart → 输入 → PermissionRequest → 批准 → Stop',
     '在 claude 窗口选 Yes, I trust this folder，按 E04、E05 走一遍', '“谁在等你”这个核心能力还没被真实验证', '先手动验收 E04/E05；之后写进端到端测试', 'E04 E05'),
    ('Q02', 'P0', '未验证', 'workspace-service · 白板', '从界面新建 worktree 工作区、在框里开终端，从没在真窗口里走过', '按 E01、E02 走一遍', '多分支并行的基础，没走过就不能说 MVP 可用', '手动验收 E01/E02', 'E01 E02'),
    ('Q03', 'P0', '未验证', '整体', '同一仓库两个工作区、两个 claude 并行改代码，从没试过', '按 E03 走一遍', '这是产品的核心卖点', '手动验收 E03', 'E03'),
    ('Q04', 'P0', '缺失', 'e2e', '没有端到端自动测试（任务 R2）：仓库里没有 Playwright、没有 e2e 目录；14 条验收场景都没自动化', '—', '以后每次改动都要靠人工回归', '用 Playwright 的 Electron 模式，先做能完全自动的 E01 E02 E06 E07 E09 E10 E12', '全部'),
    ('Q05', 'P0', '未验证', 'tmux-host · 终端窗口', 'F7 列的 9 项终端手感只能人看，都还没确认：颜色和框线字符、Esc / Shift+Enter / 多行粘贴、触控板滚动和回滚、拖选复制、和系统终端同时接上、claude 完成提醒等', '照 packages/tmux-host/AGENTS.md「需要人工确认」逐项试', '终端是天天用的东西，手感不对很快就不想用', '验收时逐项打勾，有问题记成新的 Q', ''),
    ('Q06', 'P1', '缺陷', 'agent-adapters', 'claude 停在“信任这个文件夹”提示时，状态显示 Idle，应该算在等你', '打开一个没信任过的目录里的 claude', '用户以为 claude 在空闲，其实它卡着等你', '状态机把启动后迟迟没有 SessionStart、且屏幕停住的情况算 needs-reply，或识别信任提示', 'E04'),
    ('Q07', 'P1', '缺陷', '终端窗口', '连着新建两个终端时，第二个可能误显示 “Previous session ended”（它复用了 500 毫秒内的 terminals.list() 结果）', '快速连开两个终端', '用户以为终端没起来', '新建后强制刷新列表，或按 terminalId 精确查询', 'E03'),
    ('Q09', 'P1', '技术债', 'tmux-host', 'pty.ts 自己声明了顶层 const require，和 electron-vite 注入的重名，终端进程一启动就崩；组装时在构建配置里绕过', '去掉桌面构建配置里的绕过插件后启动', '换构建工具或打包时会再炸', '在 tmux-host 里改名，去掉绕过', ''),
    ('Q10', 'P1', '技术债', 'tmux-host', '打包后默认的 tmux.conf 路径不对，应用现在总是显式传路径', '打包后不传路径启动', '打包时容易漏', '默认路径按打包后的资源目录算', ''),
    ('Q11', 'P1', '未验证', 'apps/desktop', '从程序坞打开时读登录 shell 环境（PATH、代理）没验证过：只从终端 pnpm dev 启动过，那时环境本来就全', '有打包版本后从程序坞打开，开 claude 发一句话', '之前 403 就是缺代理变量导致的', '和 Q37 一起做', 'E20'),
    ('Q12', 'P1', '需求不一致', '需求 · agent-adapters', '验收场景 5 写“直接按 y 批准”，claude 实测“允许一次”是 1 或回车，y 能不能用不确定', '在 claude 的批准提示里按 y 试一次', '按错键可能选到别的选项', '改需求写法为“按 agent 的允许一次键（claude 是 1）”，或实测 y 后定下', 'E05'),
    ('Q13', 'P1', '缺失', '白板 · apps/desktop', '没有 Settings 界面：设置存在 settings.json，点 Settings 用系统程序打开它；需求里的 Settings › Projects、Settings › Agents 都没有', '点顶栏 Settings', '项目设置、agent 启动参数、破坏性命令名单都只能手改 JSON', '先做 Projects 和 Agents 两页', 'E15'),
    ('Q14', 'P1', '未验证', 'apps/desktop', '系统通知真弹出、单击后窗口回来并跳到终端，没验证', '按 E13 走一遍', '后台提醒是“不用盯着”的关键', '手动验收 E13', 'E04 E13'),
    ('Q16', 'P1', '未验证', 'apps/desktop · 白板', '焦点在网页窗口里时，用真键盘按应用快捷键没验证过（只用菜单项触发过）', '按 E18 走一遍', '快捷键失灵会很烦', '手动验收 E18', 'E18'),
    ('Q17', 'P1', '技术债', 'contracts', '线 1 的 13 条接口意见没整理成 0.1.4：关闭确认不知道进程在不在跑、⌘K 只发 Ctrl+L 没清历史、拖入文件拿不到路径、没有打开外部链接、没有终端配色 token 等', '看 packages/tmux-host/CONTRACT_NOTES.md', '这些地方现在是各包自己临时处理', '出 contracts 0.1.4 并跟进实现', ''),
    ('Q24', 'P1', '未验证', '白板 · workspace-service', '在真窗口里删除工作区并删目录没走过（会真删磁盘目录）', '在测试仓库上按 E12 走一遍', '删除是不可逆操作，必须先验证', '手动验收 E12', 'E12'),
    ('Q08', 'P2', '缺陷', 'agent-adapters · contracts', '重开应用后终端状态都显示 “Idle · now”，开始时间没接上', '有终端在跑时 ⌘Q 再打开', '计时不准，但不影响使用', '状态机接受恢复时的真实开始时间', 'E10'),
    ('Q15', 'P2', '未验证', '终端窗口 · apps/desktop', 'Open in system terminal 没真点过', '按 E11 走一遍', '辅助功能', '手动验收 E11', 'E11'),
    ('Q18', 'P2', '技术债', '白板 · 网页窗口 · git · agent', '线 2–5 还没把 contracts 0.1.3 的新字段用进代码：白板仍按 type === "terminal" 写特例、reuseKey 不随白板保存、网页窗口用本地的 reloadToken、远端分支和接回已有 worktree 没实现等', '看各包 CONTRACT_NOTES.md 开头的“待跟进”', '加新窗口类型时要改白板', '各包跟进一轮', ''),
    ('Q19', 'P2', '缺失', 'workspace-service', '没有“worktree 放在哪”的选项，开发模式下借用 .agentdeck-dev 里的假主目录', '开发模式下新建 worktree，看它的路径', '开发和正式版路径不一致', '给 workspace-service 加 worktreeRoot 参数', 'E02'),
    ('Q20', 'P2', '缺陷', '白板', '第二次调用 start() 在白板加载完之前就返回', '连续调用两次 controller.start()', '应用里已绕过（先 start 再渲染）', '让 start() 返回同一个 Promise', ''),
    ('Q21', 'P2', '缺陷', '白板', '新建终端菜单会列出用不了的 custom，并按 agent id 而不是名字显示', '右键 › New terminal ▸', '应用里先藏了 custom', '按 AgentInfo.label 显示，过滤 custom', 'E17'),
    ('Q22', 'P2', '缺陷', '源代码管理面板', '没有聚焦任何窗口时也显示 “This window isn’t in a workspace.”', '打开应用不点任何东西', '文案让人困惑', '区分“没聚焦”和“聚焦的是散放窗口”', 'E16'),
    ('Q23', 'P2', '未验证', '白板 · 终端窗口', '在真窗口里拉小成摘要卡、再恢复，画面会不会乱没验证', '按 E09 走一遍', '摘要卡是放下更多窗口的办法', '手动验收 E09', 'E09'),
    ('Q25', 'P2', '未验证', '源代码管理面板', '单击被别的工作区占用的分支跳到那个框，没在真窗口里试', '按 E08 走一遍', '辅助功能', '手动验收 E08', 'E08'),
    ('Q26', 'P2', '未验证', '性能', '三项完成标准没测量：30 个窗口平移不掉帧（B1）、Electron 里 6 个终端打字延迟（T2，只量到 tmux-host 层）、空闲时 CPU 接近 0（G4）', '写测量脚本', '流畅是一开始的要求之一', '用组装好的应用加调试端口测', ''),
    ('Q27', 'P2', '未验证', 'apps/desktop · store', '强杀应用进程（不是 ⌘Q）后再打开，布局和终端恢复没测过', 'kill -9 主进程后再打开', '崩溃后能不能恢复', '手动试一次，再写进端到端', 'E10'),
    ('Q28', 'P2', '缺失', 'apps/desktop', 'IPC 层的“统一超时包装”没找到，只有错误码透传', '看 apps/desktop/src/main/ipc.ts', '某个服务卡住时界面会一直等', '给 invoke 加默认超时', ''),
    ('Q29', 'P2', '未验证', 'CI', 'GitHub Actions 从没跑过；工作流里也没装 tmux，真 tmux 的测试在 CI 上会被跳过', '—', '只能靠本机跑 pnpm check', '给出仓库名后推送；工作流里 brew/apt 装 tmux 3.5+', ''),
    ('Q36', 'P2', '缺失', '整体', '重启电脑后恢复会话（验收场景 14）还没做', '—', '属于 MVP 完整版', '按计划在 M4 做', 'E14'),
    ('Q37', 'P2', '缺失', 'apps/desktop', '没有打包流程：better-sqlite3 的 asarUnpack、node-pty spawn-helper 权限、tmux.conf 和 agentdeck-notify 的资源路径都还没进打包配置', '—', '现在只能从源码 pnpm dev 启动，不能放进程序坞', '加 electron-builder 配置，产出 .app', 'E20'),
    ('Q30', 'P3', '清理', '白板', '右下角有 React Flow 的水印', '看截图右下角', '外观', '关掉水印', ''),
    ('Q31', 'P2', '清理', 'git', '开发期间留下十几个已合并的分支和 worktree，面板 Repository 区和分支下拉里全列出来了（Q38 就是点到了其中一个）', 'git worktree list', '列表很乱', '确认后删掉已合并的 claude/* 分支和对应 worktree', ''),
    ('Q32', 'P3', '清理', '开发环境', 'Electron 二进制要手动下载一次（pnpm 10 不跑依赖的 postinstall）', '新克隆后 pnpm dev 报 Electron uninstall', '新环境第一次启动会失败', '在 pnpm 配置里允许 electron 的安装脚本，或在根目录加 setup 脚本', ''),
    ('Q33', 'P3', '清理', '开发环境', 'dev 的 tmux 实例里留着 4 个演示会话，其中 2 个来自组装用的 worktree', 'tmux -L agentdeck-desktop-dev ls', '无害，占一点资源', '验收完后 tmux -L agentdeck-desktop-dev kill-server', ''),
    ('Q34', 'P3', '技术债', 'agent-adapters 测试', '真 agent 测试会自动回答 codex 的“信任这个文件夹”，往用户的 codex 配置里写记录', '看 real-agents.test.ts', '跑测试会改用户配置', '测试里用临时 CODEX_HOME 和 CLAUDE_CONFIG_DIR', ''),
]

thin = Side(style='thin', color='D9D9D4')
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)
HEAD_FILL = PatternFill('solid', fgColor='1A1A1A')
HEAD_FONT = Font(name=FONT, bold=True, color='FFFFFF', size=11)
BODY_FONT = Font(name=FONT, size=10)
BOLD = Font(name=FONT, size=10, bold=True)
INPUT_FILL = PatternFill('solid', fgColor='FFF7D6')   # 用户填写
PROBLEM_FILL = PatternFill('solid', fgColor='FBE3D6') # 当前有问题
WRAP_TOP = Alignment(wrap_text=True, vertical='top')
CENTER = Alignment(horizontal='center', vertical='top', wrap_text=True)

STATUS_FILL = {
    '⚠ 当前有问题': PatternFill('solid', fgColor='C2410C'),
    '未验证': PatternFill('solid', fgColor='E7E6E1'),
    '部分验证': PatternFill('solid', fgColor='F3E6B8'),
    '已验证': PatternFill('solid', fgColor='CFE5D6'),
    '未实现': PatternFill('solid', fgColor='EFEFEF'),
}
P_FILL = {
    'P0': PatternFill('solid', fgColor='C2410C'),
    'P1': PatternFill('solid', fgColor='E9A57E'),
    'P2': PatternFill('solid', fgColor='F3E6B8'),
    'P3': PatternFill('solid', fgColor='E7E6E1'),
}

wb = Workbook()

# ---------- 说明 ----------
ws = wb.active
ws.title = '说明'
rows = [
    ('AgentDeck MVP 端到端用例与问题清单', None),
    ('生成时间', '2026-10-24，基于 main 925c11f（下午补了 E24、Q38、Q39，Q38、Q39 已修）。证据来自各包测试、apps/desktop/ASSEMBLY_NOTES.md、2026-10-23 的组装和两次启动截图。'),
    ('', None),
    ('怎么用', None),
    ('1', '先看「端到端用例」：排在最前面、标着“⚠ 当前有问题”的是已知会出问题的用例，问题写在“当前问题”列。'),
    ('2', '按“前置要求 → 操作步骤”去试，对照“UI / 后台预期表现”和“最终效果”判断，在黄色的“验收结果”“验收备注”两列填写。'),
    ('3', '「问题清单」按 P 级排好了，解决一条就把“处理状态”改成“已解决”，「汇总」会自动更新。'),
    ('', None),
    ('需要你填的列', '黄色底的列：端到端用例的“验收结果”“验收备注”；问题清单的“处理状态”“处理备注”。其他列不用改。'),
    ('验收结果怎么填', '通过 / 不通过 / 阻塞（前置条件做不到）/ 跳过。下拉可选。'),
    ('', None),
    ('用例状态的含义', None),
    ('⚠ 当前有问题', '已经知道这个流程里有缺陷或和需求不一致，问题写在“当前问题”列'),
    ('未验证', '功能写了、有自动测试，但没在真的应用窗口里走过'),
    ('部分验证', '流程里有几步在真窗口里试过，其余没有'),
    ('已验证', '2026-10-23 组装时在真窗口里走通过'),
    ('未实现', '属于 MVP 完整版（P1 功能），还没做'),
    ('', None),
    ('P 级的含义', None),
    ('P0', '阻塞 MVP 验收：不修好或不验证完，就不能说基础 MVP 完成'),
    ('P1', '影响主要流程的正确性或可用性，有绕过办法，MVP 交付前要处理'),
    ('P2', '次要体验、完整性、性能测量，MVP 之后可以做'),
    ('P3', '工程卫生、清理'),
    ('', None),
    ('示例填写', '端到端用例 E21（已验证）一行里，“验收结果”可以填“通过”，“验收备注”写“在 ~ 里打开，输出正常”。'),
]
for r, (a, b) in enumerate(rows, 1):
    ws.cell(r, 1, a)
    if b is not None:
        ws.cell(r, 2, b)
    for c in (1, 2):
        cell = ws.cell(r, c)
        cell.font = BODY_FONT
        cell.alignment = WRAP_TOP
ws['A1'].font = Font(name=FONT, size=16, bold=True)
for r in (4, 12, 19):
    ws.cell(r, 1).font = Font(name=FONT, size=12, bold=True)
for r in range(13, 18):
    ws.cell(r, 1).fill = STATUS_FILL[ws.cell(r, 1).value]
    if ws.cell(r, 1).value == '⚠ 当前有问题':
        ws.cell(r, 1).font = Font(name=FONT, size=10, bold=True, color='FFFFFF')
for r in range(20, 24):
    ws.cell(r, 1).fill = P_FILL[ws.cell(r, 1).value]
    ws.cell(r, 1).font = Font(name=FONT, size=10, bold=True, color='FFFFFF' if ws.cell(r, 1).value in ('P0',) else '1A1A1A')
ws.cell(9, 2).fill = INPUT_FILL
for r in (2, 9, 10, 25):
    ws.cell(r, 1).font = BOLD
ws.column_dimensions['A'].width = 18
ws.column_dimensions['B'].width = 110

# ---------- 端到端用例 ----------
ws = wb.create_sheet('端到端用例')
heads = ['用例编号', '优先级', '当前状态', '业务场景', '前置要求', '操作步骤', 'UI / 后台预期表现', '最终效果', '当前问题', '关联问题', '验收结果', '验收备注']
widths = [10, 8, 14, 30, 30, 38, 60, 26, 46, 12, 12, 30]
for c, (h, w) in enumerate(zip(heads, widths), 1):
    cell = ws.cell(1, c, h)
    cell.font = HEAD_FONT
    cell.fill = HEAD_FILL
    cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    cell.border = BORDER
    ws.column_dimensions[get_column_letter(c)].width = w
for c in (11, 12):
    ws.cell(1, c).fill = PatternFill('solid', fgColor='8A6D1F')

for r, k in enumerate(CASES, 2):
    vals = [k['id'], k['p'], k['status'], k['scene'], k['pre'], k['steps'], k['expect'], k['result'], k['issue'], k['rel'], None, None]
    for c, v in enumerate(vals, 1):
        cell = ws.cell(r, c, v)
        cell.font = BODY_FONT
        cell.alignment = WRAP_TOP
        cell.border = BORDER
    ws.cell(r, 1).font = BOLD
    for c in (1, 2, 3, 10, 11):
        ws.cell(r, c).alignment = CENTER
    st = ws.cell(r, 3)
    st.fill = STATUS_FILL[k['status']]
    if k['status'] == '⚠ 当前有问题':
        st.font = Font(name=FONT, size=10, bold=True, color='FFFFFF')
        ws.cell(r, 9).fill = PROBLEM_FILL
        ws.cell(r, 9).font = Font(name=FONT, size=10, color='8A2B07')
    pc = ws.cell(r, 2)
    pc.fill = P_FILL[k['p']]
    pc.font = Font(name=FONT, size=10, bold=True, color='FFFFFF' if k['p'] == 'P0' else '1A1A1A')
    for c in (11, 12):
        ws.cell(r, c).fill = INPUT_FILL
last_case = len(CASES) + 1
ws.freeze_panes = 'D2'
ws.auto_filter.ref = f'A1:L{last_case}'
dv = DataValidation(type='list', formula1='"通过,不通过,阻塞,跳过"', allow_blank=True)
ws.add_data_validation(dv)
dv.add(f'K2:K{last_case}')
# 验收结果填“不通过”时整行标红
ws.conditional_formatting.add(f'K2:K{last_case}', FormulaRule(formula=['$K2="不通过"'], fill=PatternFill('solid', fgColor='F4C7C3')))
ws.conditional_formatting.add(f'K2:K{last_case}', FormulaRule(formula=['$K2="通过"'], fill=PatternFill('solid', fgColor='CFE5D6')))

# ---------- 问题清单 ----------
ws2 = wb.create_sheet('问题清单')
heads2 = ['问题编号', 'P 级', '类型', '所属模块', '问题描述', '怎么复现 / 怎么验证', '影响', '建议处理', '关联用例', '处理状态', '处理备注']
widths2 = [10, 8, 12, 22, 60, 36, 32, 40, 12, 12, 30]
for c, (h, w) in enumerate(zip(heads2, widths2), 1):
    cell = ws2.cell(1, c, h)
    cell.font = HEAD_FONT
    cell.fill = HEAD_FILL
    cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    cell.border = BORDER
    ws2.column_dimensions[get_column_letter(c)].width = w
for c in (10, 11):
    ws2.cell(1, c).fill = PatternFill('solid', fgColor='8A6D1F')
order = {'P0': 0, 'P1': 1, 'P2': 2, 'P3': 3}
issues = sorted(ISSUES, key=lambda x: (order[x[1]], x[0]))
for r, row in enumerate(issues, 2):
    vals = list(row) + ['待处理', None]
    for c, v in enumerate(vals, 1):
        cell = ws2.cell(r, c, v)
        cell.font = BODY_FONT
        cell.alignment = WRAP_TOP
        cell.border = BORDER
    ws2.cell(r, 1).font = BOLD
    for c in (1, 2, 3, 9, 10):
        ws2.cell(r, c).alignment = CENTER
    pc = ws2.cell(r, 2)
    pc.fill = P_FILL[row[1]]
    pc.font = Font(name=FONT, size=10, bold=True, color='FFFFFF' if row[1] == 'P0' else '1A1A1A')
    for c in (10, 11):
        ws2.cell(r, c).fill = INPUT_FILL
last_issue = len(issues) + 1
ws2.freeze_panes = 'C2'
ws2.auto_filter.ref = f'A1:K{last_issue}'
dv2 = DataValidation(type='list', formula1='"待处理,处理中,已解决,不处理"', allow_blank=False)
ws2.add_data_validation(dv2)
dv2.add(f'J2:J{last_issue}')
ws2.conditional_formatting.add(f'J2:J{last_issue}', FormulaRule(formula=['$J2="已解决"'], fill=PatternFill('solid', fgColor='CFE5D6')))

# ---------- 汇总（公式） ----------
ws3 = wb.create_sheet('汇总')
ws3['A1'] = '汇总'
ws3['A1'].font = Font(name=FONT, size=14, bold=True)
ws3['A2'] = '下面的数字都是公式，改了另外两张表会自动更新。'
ws3['A2'].font = Font(name=FONT, size=10, color='6B6B66')

def head(row, labels):
    for c, h in enumerate(labels, 1):
        cell = ws3.cell(row, c, h)
        cell.font = HEAD_FONT
        cell.fill = HEAD_FILL
        cell.alignment = Alignment(horizontal='center')
        cell.border = BORDER

C = f"'端到端用例'!$C$2:$C${last_case}"
K = f"'端到端用例'!$K$2:$K${last_case}"
B = f"'端到端用例'!$B$2:$B${last_case}"
head(4, ['用例状态', '用例数', '已验收通过', '验收不通过'])
r = 5
for s in ['⚠ 当前有问题', '未验证', '部分验证', '已验证', '未实现']:
    ws3.cell(r, 1, s)
    ws3.cell(r, 2, f'=COUNTIF({C},A{r})')
    ws3.cell(r, 3, f'=COUNTIFS({C},A{r},{K},"通过")')
    ws3.cell(r, 4, f'=COUNTIFS({C},A{r},{K},"不通过")')
    r += 1
ws3.cell(r, 1, '合计')
for c, col in ((2, 'B'), (3, 'C'), (4, 'D')):
    ws3.cell(r, c, f'=SUM({col}5:{col}{r-1})')
total_case_row = r
for rr in range(5, r + 1):
    for c in range(1, 5):
        ws3.cell(rr, c).font = BOLD if rr == r else BODY_FONT
        ws3.cell(rr, c).border = BORDER
        if c > 1:
            ws3.cell(rr, c).alignment = Alignment(horizontal='center')

P = f"'问题清单'!$B$2:$B${last_issue}"
J = f"'问题清单'!$J$2:$J${last_issue}"
start = total_case_row + 2
head(start, ['问题 P 级', '问题数', '已解决', '未解决'])
r = start + 1
for p in ['P0', 'P1', 'P2', 'P3']:
    ws3.cell(r, 1, p)
    ws3.cell(r, 2, f'=COUNTIF({P},A{r})')
    ws3.cell(r, 3, f'=COUNTIFS({P},A{r},{J},"已解决")')
    ws3.cell(r, 4, f'=B{r}-C{r}')
    ws3.cell(r, 1).fill = P_FILL[p]
    r += 1
ws3.cell(r, 1, '合计')
for c, col in ((2, 'B'), (3, 'C'), (4, 'D')):
    ws3.cell(r, c, f'=SUM({col}{start+1}:{col}{r-1})')
for rr in range(start + 1, r + 1):
    for c in range(1, 5):
        ws3.cell(rr, c).font = BOLD if rr == r else BODY_FONT
        ws3.cell(rr, c).border = BORDER
        if c > 1:
            ws3.cell(rr, c).alignment = Alignment(horizontal='center')
ws3.cell(start + 1, 1).font = Font(name=FONT, size=10, bold=True, color='FFFFFF')

s2 = r + 2
head(s2, ['用例优先级', '用例数', '已验收通过', '未通过或未验收'])
r = s2 + 1
for p in ['P0', 'P1', 'P2']:
    ws3.cell(r, 1, p)
    ws3.cell(r, 2, f'=COUNTIF({B},A{r})')
    ws3.cell(r, 3, f'=COUNTIFS({B},A{r},{K},"通过")')
    ws3.cell(r, 4, f'=B{r}-C{r}')
    ws3.cell(r, 1).fill = P_FILL[p]
    for c in range(1, 5):
        ws3.cell(r, c).font = BODY_FONT
        ws3.cell(r, c).border = BORDER
        if c > 1:
            ws3.cell(r, c).alignment = Alignment(horizontal='center')
    r += 1
ws3.cell(s2 + 1, 1).font = Font(name=FONT, size=10, bold=True, color='FFFFFF')
for col, w in zip('ABCD', (18, 12, 14, 16)):
    ws3.column_dimensions[col].width = w

# 已经处理的问题：处理状态和备注
RESOLVED = {
    'Q38': '2026-10-24 已修（925c11f）：只要目录里有终端开着就确认，确认框列出这些终端；面板加了测试',
    'Q39': '2026-10-24 已修（925c11f）：应用启动时找出自己运行的目录，界面对它切分支、建分支并切换、连目录删除都拒绝；真窗口里验证过',
}
for r in range(2, last_issue + 1):
    note = RESOLVED.get(ws2.cell(r, 1).value)
    if note:
        ws2.cell(r, 10).value = '已解决'
        ws2.cell(r, 11).value = note

# 没有 LibreOffice 可以预先算好公式，打开时让 Excel / Numbers / WPS 全部重算
wb.calculation.fullCalcOnLoad = True
wb.save(OUT)
print('cases', len(CASES), 'issues', len(ISSUES), '->', OUT)
# 供核对：公式应得出的数字
from collections import Counter
print('用例状态', dict(Counter(k['status'] for k in CASES)))
print('用例优先级', dict(Counter(k['p'] for k in CASES)))
print('问题 P 级', dict(Counter(i[1] for i in ISSUES)))
