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
  },
  {
    id: 'kimi',
    label: 'Kimi',
    commands: ['kimi'],
    launch: { new: [], resume: ['-S', '{id}'], fork: null },
    extension: null,
    askTool: false,
    approveOnceKeys: null,
  },
];
