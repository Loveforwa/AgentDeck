// 终端的 token 用量（插件 PL2 · Usage，需求见设计画布“插件能力”页，调研见 DR-55）。
// 实现：packages/agent-adapters 的 usage 模块，运行在主进程。按终端的会话 id 找到 agent 自己的会话文件，
// 只读新增的部分，每次请求后一秒内发 usage.changed。只读用户数据，不改 agent 的任何文件。
// 调用：终端窗口上的用量条（线 1 / 插件）。
//
// 原则：读不到的就是没有，不估。整体读不到时 state 为 'no-data'；某一项 agent 不报时那一项为 null。

import type { AbsPath, AgentKind, AgentSessionId, IsoTime, TerminalId } from './common.ts';

/** 一组 token 数。累计和“最近一次请求”都用它。 */
export interface TokenCounts {
  /** 输入 token，不含缓存读写。 */
  input: number;
  /** 输出 token，含思考。 */
  output: number;
  /** 缓存读。 */
  cacheRead: number;
  /** 缓存写。agent 不报时为 null。 */
  cacheWrite: number | null;
  /** 输出里思考的部分（已经算在 output 里）。agent 不单独报时为 null。 */
  reasoning: number | null;
}

/** 当前对话的上下文长度。 */
export interface ContextUsage {
  /** 当前上下文的 token 数。刚压缩完、下一次请求之前不知道，为 null。 */
  tokens: number | null;
  /** 上下文窗口大小。不知道时为 null。 */
  window: number | null;
  /** 0–100。tokens 或 window 不知道时为 null。 */
  percent: number | null;
  /**
   * 窗口大小从哪来：agent 自己报的（codex 会话文件、pi / omp 扩展）、按模型表（claude）、
   * agent 的配置文件（kimi 的 max_context_size）、看到的上下文已经超过默认窗口推出来的（claude）。
   */
  windowSource: 'agent' | 'model-table' | 'config' | 'observed' | null;
}

/** 账号的额度窗口（codex 的 5 小时、每周）。 */
export interface RateLimitWindow {
  /** 0–100。 */
  usedPercent: number;
  /** 窗口长度，300 是 5 小时，10080 是一周。不知道时为 null。 */
  windowMinutes: number | null;
  resetsAt: IsoTime | null;
}

export type UsageState =
  | 'ok' // 读到了
  | 'no-data' // 支持这种 agent，但现在读不到（还没有会话 id、会话文件还没写、文件里还没有用量）
  | 'unsupported'; // shell、自定义命令、不认识的 agent

export interface TerminalUsage {
  terminalId: TerminalId;
  agent: AgentKind | null;
  state: UsageState;
  /** state 不是 ok 时给人看的一句话，英文，例如 "No session file yet"。 */
  reason: string | null;
  sessionId: AgentSessionId | null;
  /**
   * 会话怎么对上这个终端的：exact = 会话 id（启动参数或钩子）；
   * inferred = 按目录和启动时间猜的（kimi 新建会话没有 id），可能对错，界面悬停时要写明。
   */
  match: 'exact' | 'inferred' | null;
  /** 读的是哪个会话文件。 */
  file: AbsPath | null;
  /** 最近一次请求用的模型，原样，例如 "claude-opus-5-5"。 */
  model: string | null;
  /** 这次对话累计。 */
  total: TokenCounts | null;
  /** 最近一次请求。 */
  last: TokenCounts | null;
  /** 请求次数（一次 API 调用算一次）。 */
  requests: number;
  context: ContextUsage | null;
  /** 只有 codex 有（会话文件里带着账号额度）。 */
  rateLimits: { primary: RateLimitWindow | null; secondary: RateLimitWindow | null } | null;
  /** 最后一条用量记录的时间。 */
  updatedAt: IsoTime | null;
  /**
   * PL3：agent 最近一次碰到账号额度上限、还没恢复（之后没有成功的请求）。没碰到、或已经恢复为 null；老的实现不填。
   * claude 读会话记录里 error "rate_limit" 那一行的 quotaLimits，codex 读 usage_limit_exceeded 和 rate_limits（DR-63）。
   */
  limit?: UsageLimit | null;
}

/** PL3：碰到的额度上限。 */
export interface UsageLimit {
  /** five_hour：5 小时额度；weekly：每周额度；other：别的（按原样写在 detail 里）。 */
  kind: 'five_hour' | 'weekly' | 'other';
  /** 什么时候恢复。agent 没记下时为 null。 */
  resetsAt: IsoTime | null;
  /** 碰到上限的时间（那一条记录的时间）。 */
  at: IsoTime | null;
  /** agent 原样的说法，例如 "You've hit your usage limit … try again at 3:30 PM."。 */
  detail: string | null;
}

export interface UsageService {
  /** 现在的用量。没在 watch 的终端也能取（读一次）。 */
  get(terminalId: TerminalId): Promise<TerminalUsage>;
  /**
   * 开始跟踪这个终端：之后每次有变化发 usage.changed。返回当前值。重复调用没有副作用。
   * 插件在这个终端上开着时调；关掉时调 unwatch，不留监听。
   */
  watch(terminalId: TerminalId, owner?: string): Promise<TerminalUsage>;
  /**
   * owner（PL3 起）：谁在看，例如 'usage-strip'、'prompt-queue'。同一个终端可以有好几个 owner 同时 watch，
   * 最后一个 unwatch 了才停；不给时当成 'default'。
   */
  unwatch(terminalId: TerminalId, owner?: string): Promise<void>;
}

export type UsageEvent = { type: 'usage.changed'; usage: TerminalUsage };
