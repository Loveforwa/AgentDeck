// 账号的额度上限、被打断的终端、续跑（插件 Auto-resume 的第一步，M7 · PL4；需求见设计画布“MVP 插件”页 PluginResume，调研 DR-84）。
// 额度是按账号算的：一个账号用完，同一家的几个终端一起停。识别、按账号归组、错开续跑、Keep Mac awake 只在主进程写一份
// （packages/agent-adapters 的 limits 模块，PL5），Auto-resume（PL6）和集群（CR8）都经过这里。
// 0.1.23：Prompt queue（PL3）2026-10-28 退役（各家 agent 自己会排提示词；要紧的是撞上限那一刻的续跑和改续跑的话），
// 剩下的部分并进 Auto-resume：卡片里能改这一次续跑发的文字（setMessage、LimitedTerminal.message / defaultMessage）。
// 下面提到 PL3 的地方是老说法，留着不删（只加不改）。
// 调用：收件箱的 Usage limit 一条（CR1）、终端底边的书签、集群调度器。

import type { AbsPath, AgentKind, IsoTime, TerminalId } from './common.ts';
import type { UsageLimit } from './usage.ts';

/** 额度的范围：all 是整个账号；opus、sonnet 是 claude 每周的单独额度（quotaLimits.rateLimitType 为 seven_day_opus / seven_day_sonnet）。 */
export type LimitScope = 'all' | 'opus' | 'sonnet';

/** 账号键，形如 `<agent>:<配置目录>:<范围>`，例如 'codex:/Users/you/.codex:all'。由服务生成，界面只原样传回。 */
export type AccountKey = string;

/**
 * 一个终端在这次额度上限里的情况：
 * - interrupted：这一轮是被额度结束的（干到一半），等恢复后续跑。
 * - idle：同一账号，当时空闲、自己没撞；不续跑，排着的提示词（PL3）在这次恢复后照发。
 * - took-over：撞完以后你在这个终端里打过字，不管它。
 * - resuming：续跑提示发出去了，这一轮在跑。
 * - resumed：续跑这一轮做完了。
 * - skipped：你去掉了勾（skip）或这一组 Don’t resume（cancel）。
 * - handed-off：集群把这个任务换给了另一家（CR8），原终端不续。
 * - gave-up：连续两次续了又撞、或读不到恢复时间，停下进收件箱。
 */
export type LimitedTerminalState =
  | 'interrupted'
  | 'idle'
  | 'took-over'
  | 'resuming'
  | 'resumed'
  | 'skipped'
  | 'handed-off'
  | 'gave-up';

/**
 * 谁来续：auto-resume 是本插件；crew 是集群调度器（CR8，它调 resumeNow）；agent 是 agent 自己会续（claude 2.1.234 起、omp），
 * AgentDeck 只盯着；run 是 Day run 选了 Hand off（LR7），Auto-resume 不插手（选 Wait 时仍是 auto-resume）。
 */
export type LimitOwner = 'auto-resume' | 'crew' | 'agent' | 'run';

/**
 * 0.1.22：agent 自己续跑（owner agent，claude 2.1.234 起）走到哪一步，对应 claude 的 Notification quota_auto_resume_*：
 * - waiting：还没恢复，或恢复了还没动静（等它自己续）；
 * - fired：它开始续了（收到 fired，或恢复后看到它开始干活）；
 * - stale：卡在等你按回车（Mac 睡过了恢复时间）；
 * - disabled：用户关了 claude 自己的续跑，改由 AgentDeck 发（owner 随之变成 auto-resume）。
 */
export type SelfResumeState = 'waiting' | 'fired' | 'stale' | 'disabled';

export interface LimitedTerminal {
  terminalId: TerminalId;
  state: LimitedTerminalState;
  owner: LimitOwner;
  /** 打算几点续（恢复时间 + 1 分钟，再按先后错开 30 秒）。读不到恢复时间、不归 AgentDeck 续时为 null。 */
  resumeAt: IsoTime | null;
  /** 因为额度停掉、还没接回的后台子 agent 数（N10）。 */
  lostSubagents: number;
  /**
   * 0.1.22：这次算下来这个终端的 Auto-resume 开没开（终端 → 框 → 白板，默认关）。关着时 owner 仍是 auto-resume、resumeAt 为 null，
   * 到了恢复时间变 skipped。不填是不知道（老的实现）。
   */
  autoResume?: boolean;
  /**
   * 0.1.22：agent 自己续跑走到哪一步（见 SelfResumeState）。只在 agent 自己会续（claude 2.1.234 起）的终端上有；
   * 别的终端、老的实现不填。Prompt queue（PL3）据此决定等它续完再发，不再自己猜。
   */
  selfResume?: SelfResumeState;
  /**
   * 0.1.23（PL6）：你在 Auto-resume 卡片里为这一次上限改过的续跑文字（setMessage）。null 或不填是没改，发 defaultMessage。
   * 只管这一次：发出去以后、这一次了结后都清掉，下一次上限从默认开始。
   */
  message?: string | null;
  /**
   * 0.1.23（PL6）：没改时会发的文字：Settings 的 Resume prompt（没填用内置的那段）+ claude 断掉的后台子 agent（逐个点名）/ codex 的一句。
   * 卡片拿它预填、Reset to default 回到它。不归 AgentDeck 发（claude 自己续）时也给。老的实现不填。
   */
  defaultMessage?: string;
  /**
   * 0.1.23（PL6）：owner 是 agent（claude 自己续）时，改过的文字已经送进终端：claude 在等恢复时收到消息，恢复时改发这一条、
   * 不发它自己的 continue（DR-84，待用真 claude 核对）。送进去以后不能再改。别的情况不填。
   */
  messageDelivered?: boolean;
}

/**
 * 为什么这个账号要你处理（收件箱 WAITING FOR YOU，算进 Needs you）：reset-unknown 读不到恢复时间（kimi）；
 * slept Mac 睡过恢复时间 30 分钟以上（先问你，2026-10-28 用户定）；stale claude 自己续跑卡在等你按回车（quota-resume stale）。
 * 规格只列了终端的 gave-up；账号一级的这三种收件箱要分开写，所以加了这个可选字段。null 或不填是不用你管（放在 PAUSED 一组）。
 */
export type AccountLimitNeedsYou = 'reset-unknown' | 'slept' | 'stale';

export interface AccountLimit {
  key: AccountKey;
  agent: AgentKind;
  /** 这个账号的配置目录（CLAUDE_CONFIG_DIR / CODEX_HOME，没设就是 ~/.claude、~/.codex）。 */
  configDir: AbsPath;
  scope: LimitScope;
  /** 同 UsageLimit.kind。 */
  kind: UsageLimit['kind'];
  /** 什么时候恢复。读不到为 null。 */
  resetsAt: IsoTime | null;
  /** 第一次撞上的时间。 */
  at: IsoTime;
  /** agent 原样的说法，同 UsageLimit.detail。 */
  detail: string | null;
  /** 同一账号的终端，按被打断的先后排（也是续跑的顺序）。 */
  terminals: LimitedTerminal[];
  needsYou?: AccountLimitNeedsYou | null;
}

export interface LimitService {
  /** 现在受限的账号。界面启动时取一次，之后靠 limits.changed。全部续完、取消掉的账号不再列出。 */
  list(): Promise<AccountLimit[]>;
  /**
   * Resume now：马上续这个账号的终端（不给 terminalIds 时是所有 owner 为 auto-resume 或 crew、还在等的），照样错开 30 秒。
   * 集群调度器等恢复时也调它（带上自己的终端）。账号不存在抛 not-found。
   */
  resumeNow(account: AccountKey, terminalIds?: TerminalId[]): Promise<void>;
  /** 去掉一个终端的勾：这次不续它（state 变 skipped）。 */
  skip(terminalId: TerminalId): Promise<void>;
  /** Don’t resume：这个账号的终端都不续，排着的提示词也不发（PL3 队列变 paused；0.1.23 起 PL3 已退役）。 */
  cancel(account: AccountKey): Promise<void>;
  /**
   * 改谁来续（集群接管、Day run 选 Hand off）。prompt 是续跑时发的提示词（集群的带任务编号），不给用 Settings 里的 Resume prompt。
   */
  setOwner(terminalId: TerminalId, owner: LimitOwner, prompt?: string): Promise<void>;
  /**
   * 0.1.23（PL6）：改这个终端这一次续跑发的文字（Auto-resume 卡片的 Message）。text 为 null 或空白是回到默认（defaultMessage）。
   * 发的时候用它代替模板；setOwner 给的 prompt（集群）仍然优先。claude 自己续（owner agent）时改过的文字马上送进终端
   * （它恢复时改发这一条，见 LimitedTerminal.messageDelivered），没改就什么都不发。
   * 终端不在受限账号里抛 not-found；这一次已经发出去了（resuming 以后、或已经送进 claude）抛 invalid-argument。
   * 可选：老的实现没有它，界面就不让改。
   */
  setMessage?(terminalId: TerminalId, text: string | null): Promise<void>;
}

/** 受限的账号变了（新撞上、续了一个、取消、全部续完）。带完整的新列表。 */
export type LimitEvent = { type: 'limits.changed'; limits: AccountLimit[] };
