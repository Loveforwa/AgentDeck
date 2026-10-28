// 已知 agent 表（X13）：claude、codex 之外常见的 TUI agent，由通用适配器 KnownAgentAdapter（generic.ts）读。
// 加一个 agent：在 KNOWN_AGENTS 里加一行。每个参数都要先用真的程序核对过（--help / --version / 源码），
// 没核对过的能力填 null / false，不要猜。
//
// 核对记录（2026-10-24，macOS）：
//   pi   0.83.0（npm @earendil-works/pi-coding-agent）：--help 有 --session-id <id>（“Use exact project session ID,
//        creating it if missing”，0.76 起）、--session <path|id>、--fork <path|id>、-e <path>。
//        --fork 和 --session-id 能一起用（dist/main.js createSessionManager：forkFrom(..., { id })）。
//        新建时 --session-id 给的 id 不存在，pi 会在 stderr 打一行黄色 Warning 再建会话，不影响使用。
//        扩展事件 agent_settled 0.80.4 起才有（CHANGELOG）。没有批准确认框，也没有内置的提问工具。
//   omp  18.0.4（npm @oh-my-pi/pi-coding-agent，pi 的分支，跑在 bun 上）：--help 有 -r/--resume[=<id 前缀>]、-e；
//        --fork <id> 不在 --help 里，但源码 cli/flag-tables.ts 有，main.ts 按 id 前缀找会话再 forkFrom。
//        新会话的 id 启动时不知道，要等扩展的 session_start 报上来。提问工具叫 ask。
//        批准确认框（2026-10-25 读源码，PL1）：src/extensibility/extensions/wrapper.ts 里 select("Allow tool: <name>\n…", ["Approve", "Deny"])，
//        选择列表 src/modes/components/hook-selector.ts 的 ↑ 到顶就停、不绕回，所以 approveOnceKeys = Up Enter 一定选中 Approve
//        （只这一次，omp 的选择列表没有“总是允许”）。**没在真终端里核对**：ApprovalService 发键前先在屏幕上认出
//        Allow tool: 和 Approve / Deny（status/screens.ts），认不出就不发；autoApproveSupport 报 verified: false。
//   kimi 2.3.1（~/.kimi-code/bin/kimi，2026-10-24 从 0.29.1 升上来，0.29 的核对记录作废）：-S/--session [id]、-V/--version 还在
//        （launch 参数沿用 0.29 的核对，2.3.1 没有重新跑 --help）。没有 fork；钩子不能批准，没有扩展；会话 id 启动时不知道。
//        批准确认框（读 2.3.1 打包的源码，DR-56）：标题 Run this command? / Write this file? / Apply these edits? / Approve <Tool>?，
//        选项 1. Approve once / 2. Approve for this session / 3. Reject / 4. Reject with feedback，按数字键直接选中提交，
//        所以“允许一次”是 1。计划确认（Ready to build with this plan?）和 Start a goal? 用同一个面板但选项不同，不能答。
//        2026-10-25 定：Auto-approve / Approve all 先不支持 kimi（status/support.ts 报 "Not supported for kimi yet"），
//        所以 approveOnceKeys 仍为 null；以后要做就照上面的规则看屏幕（kimi 没有 needs-approval 状态，要在终端安静下来时看）。
// 本机没有 gemini、opencode、aider，参数没法核对，先不登记。
// MCP（N1，2026-10-25）：pi 0.83.0 没有 MCP；omp 18.0.4 用 --plugin-dir；kimi 2.3.1 的 --help 仍是 -S/--session [id]，
// 没有 MCP 的启动参数。详见 AGENTS.md「AgentDeck 的 MCP」。

import type { AgentKind } from '@agentdeck/contracts';

/** 扩展从这几个环境变量知道发给谁、自己是哪个 agent。和 tools/agentdeck-notify/bin/agentdeck-pi-extension.mjs 一致，测试会核对。 */
export const EXTENSION_ENV = {
  /** agentdeck-notify 包装脚本的绝对路径（LaunchContext.notifyCommand）。 */
  notify: 'AGENTDECK_NOTIFY',
  /** HookEnvelope.agent，也就是表里的 id。 */
  agent: 'AGENTDECK_AGENT',
  /** 哪个事件算“一轮结束”：pi 用 agent_settled，omp 没有它，用 agent_end（willContinue 为 false 时）。 */
  turnEnd: 'AGENTDECK_TURN_END',
} as const;

export interface KnownAgent {
  id: AgentKind;
  /** 菜单里显示的名字。 */
  label: string;
  /** 依次在 PATH 里找，第一个找到的就用。 */
  commands: string[];
  /** 取版本号的参数，默认 ['--version']。 */
  versionArgs?: string[];
  /**
   * 启动参数模板。`{id}` 换成要接回 / fork 的会话 id，`{newId}` 换成 AgentDeck 生成的新会话 id
   * （用了 `{newId}` 的模式启动时就知道会话 id，否则要等 session-start）。null = 不支持或没核对。
   */
  launch: { new: string[]; resume: string[] | null; fork: string[] | null };
  /**
   * AgentDeck 自带的扩展（agentdeck-pi-extension.mjs），启动时用 `<flag> <路径>` 临时加载，不改用户配置。
   * 它把 agent 的扩展事件转成钩子消息发给 HookServer。null = 没有钩子，状态只看输出活动。
   */
  extension: { flag: string; turnEnd: 'agent_settled' | 'agent_end'; minVersion: string } | null;
  /** 有提问工具（扩展会把它报成 question）。没有扩展时不算。 */
  askTool: boolean;
  /**
   * 确认框里“允许一次”的按键（tmux send-keys 的写法）。null = 没有确认框或没核对。
   * Auto-approve / Approve all 怎么用它见 status/support.ts。
   */
  approveOnceKeys: string[] | null;
  /**
   * 怎么挂 AgentDeck 的 MCP（N1）。plugin-dir：`<flag> <目录>` 临时加载 AgentDeck 自己的插件目录（mcpPluginFiles 写出的），
   * 插件清单里的 url、token、终端 id 都写成 `${环境变量}`，由 agent 自己展开。null = 启动时挂不上（原因见 AGENTS.md）。
   */
  mcp: { kind: 'plugin-dir'; flag: string; minVersion: string } | null;
  /**
   * 怎么带 AgentDeck 库里的 skill（N9，src/skills/）。plugin-dir：`<flag> <目录>`，目录里 skills/<name>/（omp，同 mcp 的插件目录格式）；
   * skill-flag：每个 skill 文件夹一个 `<flag> <文件夹>`（pi）；skills-dir：`<flag> <目录>` 指一个放 skill 文件夹的目录（kimi，
   * 会顶掉它自己发现的目录，见 LaunchSkills.keepSkillRoots）。null = 启动时带不了。
   * repoDirs：仓库里它自己会读的 skill 目录（相对目录，从 cwd 往上找到仓库根），面板上列成 repo，只显示、不开关。
   */
  skills: { kind: 'plugin-dir' | 'skill-flag' | 'skills-dir'; flag: string; minVersion: string | null; repoDirs: string[] } | null;
  /**
   * 第一条消息（AH1，StartAgentRequest.prompt，只在新会话时带）。
   * arg：放进启动参数。separator 为 '--' 时放在所有参数最后、`--` 之后（agent 认 `--`）；为 null 时 agent 不认 `--`，
   *   消息放在用户的额外参数前面（免得被某个不认识的 `--flag` 当成它的值吃掉），开头是 @ 或 - 时前面加一个空格（不然会被当成文件或参数）。
   * after-ready：交互模式没有这个参数，由 AgentService 在终端第一次安静下来后替用户打进去、按回车（LaunchSpec.sendAfterReady）；
   *   notReadyScreens 里的字出现在屏幕上时（例如“信任这个文件夹吗”），说明它还没到输入框，等下一次安静再打，免得回车替用户选了选项。
   * null = 带不了（AgentService.start 报 unsupported，不开终端）。
   */
  prompt: { kind: 'arg'; separator: '--' | null } | { kind: 'after-ready'; notReadyScreens: string[] } | null;
}

export const KNOWN_AGENTS: readonly KnownAgent[] = [
  {
    id: 'pi',
    label: 'Pi',
    commands: ['pi'],
    launch: {
      new: ['--session-id', '{newId}'],
      resume: ['--session', '{id}'],
      fork: ['--fork', '{id}', '--session-id', '{newId}'],
    },
    extension: { flag: '-e', turnEnd: 'agent_settled', minVersion: '0.80.4' },
    askTool: false,
    approveOnceKeys: null,
    // pi 不内置 MCP（README “No MCP.”、docs/usage.md），要靠扩展自己实现 MCP 客户端，见 AGENTS.md「AgentDeck 的 MCP」。
    mcp: null,
    // N9：--skill <文件夹>，可重复，和自己发现的叠加（README「Resource Options」、docs/skills.md；0.83.0 用 rpc 的 get_commands 实测列出）。
    // 仓库里读 .pi/skills、.agents/skills（从 cwd 往上，README「Skills」）。
    skills: { kind: 'skill-flag', flag: '--skill', minVersion: null, repoDirs: ['.pi/skills', '.agents/skills'] },
    // AH1（2026-10-28 用真 pi 0.83.0 核对，dist/cli/args.js parseArgs）：位置参数就是消息；不认 `--`（会被当成名字为空的未知参数，
    // 把后面一项吃成它的值）；@ 开头的是文件（找不到文件时 pi 直接退出），- 开头的是参数。所以开头是 @ 或 - 时前面加一个空格，
    // 模型收到的就是原文（前面多一个空格）。不认识的 `--x` 会吃掉后面一项，所以消息放在用户的额外参数前面。
    prompt: { kind: 'arg', separator: null },
  },
  {
    id: 'omp',
    label: 'Oh My Pi',
    commands: ['omp'],
    launch: { new: [], resume: ['--resume', '{id}'], fork: ['--fork', '{id}'] },
    // 本机实测的版本。更早的版本可能也有这些事件，没验证过就按没有处理。
    extension: { flag: '-e', turnEnd: 'agent_end', minVersion: '18.0.0' },
    askTool: true,
    // 没在真终端里核对（见上面的核对记录）：发之前 ApprovalService 会先在屏幕上认出 Approve / Deny
    approveOnceKeys: ['Up', 'Enter'],
    // --plugin-dir 加载 Claude 插件格式的目录（.claude-plugin/plugin.json 里内联 mcpServers），url 和 headers 展开 ${VAR}。
    // 18.0.4 实测（源码 discovery/helpers.ts injectPluginDirRoots、discovery/claude-plugins.ts loadMCPServers），见 AGENTS.md。
    mcp: { kind: 'plugin-dir', flag: '--plugin-dir', minVersion: '18.0.4' },
    // N9：同一个 --plugin-dir（可重复）的目录里 skills/<name>/ 也会被发现（18.0.4 源码 discovery/claude-plugins.ts loadSkills；
    // 用 bun 跑 omp 自己的 injectPluginDirRoots + loadCapability('skills') 实测列出）。仓库里读 .omp、.claude、.codex、.agent(s) 的 skills/。
    skills: { kind: 'plugin-dir', flag: '--plugin-dir', minVersion: '18.0.4', repoDirs: ['.omp/skills', '.claude/skills', '.codex/skills', '.agents/skills', '.agent/skills'] },
    // AH1（2026-10-28 用真 omp 18.0.4 核对，cli.js 的参数解析）：`--` 之后的都是消息，@ 和 - 开头的也照原文送到
    // （omp 会像你在输入框里打了 @README.md 一样另外附上那个文件）。
    prompt: { kind: 'arg', separator: '--' },
  },
  {
    id: 'kimi',
    label: 'Kimi',
    commands: ['kimi'],
    launch: { new: [], resume: ['-S', '{id}'], fork: null },
    extension: null,
    askTool: false,
    approveOnceKeys: null,
    // 2.3.1 没有挂 MCP 的启动参数，只读 KIMI_CODE_HOME、仓库根的 .mcp.json、<cwd>/.kimi-code/mcp.json，见 AGENTS.md。
    mcp: null,
    // N9：--skills-dir <目录>，可重复（2.3.1 --help）。给了它就不再自动发现用户和项目目录（读打包的源码 extraFileSkillSource.ts），
    // 所以 LaunchSkills.keepSkillRoots 把那几个目录一起传回去。仓库里读 <仓库根>/.kimi-code/skills、.agents/skills。
    skills: { kind: 'skills-dir', flag: '--skills-dir', minVersion: null, repoDirs: ['.kimi-code/skills', '.agents/skills'] },
    // AH1（2026-10-28 用真 kimi 2.3.2 核对）：交互模式没有带消息的参数（-p 是非交互的一次性问答）。启动后在输入框里打字、回车，
    // @ 开头的照原文送到。第一次在某个目录打开时先弹 “Trust this folder?”（回车会选中 Trust and continue），等用户处理完再打。
    prompt: { kind: 'after-ready', notReadyScreens: ['Trust this folder?'] },
  },
];
