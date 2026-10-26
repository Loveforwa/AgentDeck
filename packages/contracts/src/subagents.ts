// 后台 agent（MVP v3 · N10，需求见设计画布画板 13，调研 DR-61）：agent 用自带工具开的子 agent（claude 的 Agent / Task）。
// 它们跑在主 agent 的进程里，没有自己的终端，只能看，不能打字、批准或停止。
// 实现：packages/agent-adapters 的 subagents 模块（主进程），按钩子和 agent 自己的记录读出来，只读用户数据。
// 调用：终端窗口底边右侧的小提示、侧边栏的 BACKGROUND 一组、只读的记录窗口（packages/ui/canvas）。
//
// 和 N2 的子终端（open_terminals 开的、WindowNode.group）不是一回事：那些是真终端，随白板保存；这里的不保存，
// 重开应用后从空开始（记录还在 agent 自己的文件里）。

import type { AbsPath, IsoTime, TerminalId } from './common.ts';

export type BackgroundAgentState = 'running' | 'done' | 'failed';

export interface BackgroundAgent {
  /** agent 自己给的 id（claude 的 agent_id）。同一个终端里唯一。 */
  id: string;
  terminalId: TerminalId;
  /** 子 agent 的类型，原样，例如 "general-purpose"、"Explore"。不知道为 null。 */
  agentType: string | null;
  /** 主 agent 给它的任务描述，例如 "Weather 10 years ago"。还没读到为 null。 */
  description: string | null;
  /** true：后台跑（主 agent 不等它）；false：前台（主 agent 等它做完）；不知道为 null。 */
  background: boolean | null;
  state: BackgroundAgentState;
  /** failed 时的原因，英文，例如 "Interrupted"。 */
  reason: string | null;
  startedAt: IsoTime;
  endedAt: IsoTime | null;
  /** 做完时 agent 报的用时（毫秒）。跑着、或 agent 没报时为 null，界面按 startedAt / endedAt 算。 */
  durationMs: number | null;
  /** 这个子 agent 用了多少 token：做完时用 agent 报的数，跑着时是最近一次请求的上下文加输出。读不到为 null。 */
  tokens: number | null;
  /** 最近一步，一行，例如 "WebSearch beijing weather 2016"。还没有为 null。 */
  lastStep: string | null;
  /** 属于现在这一轮：你上次给主 agent 发消息之后开的，或者还在跑。终端底边的小提示只数这些。 */
  current: boolean;
}

export interface TerminalBackgroundAgents {
  terminalId: TerminalId;
  /** 按开始的先后。终端关掉或一个都没有时为空数组。 */
  agents: BackgroundAgent[];
}

/** 记录窗口里的一行：prompt 是主 agent 给的任务，tool 是一次工具调用，result 是工具的结果，text 是它说的话。 */
export type TranscriptLineKind = 'prompt' | 'tool' | 'result' | 'text' | 'error';

export interface TranscriptLine {
  kind: TranscriptLineKind;
  /** 原样的文字，可能有多行。很长的会被截短。 */
  text: string;
}

export interface BackgroundAgentTranscript {
  terminalId: TerminalId;
  agentId: string;
  /** 最近的若干行，按先后。 */
  lines: TranscriptLine[];
  /** 前面还有多少行没给。 */
  omitted: number;
  /** 读的是哪个记录文件。 */
  file: AbsPath | null;
  state: 'ok' | 'no-data';
  /** state 为 no-data 时给人看的一句话，英文，例如 "No transcript yet"。 */
  reason: string | null;
}

export interface SubagentService {
  /** 所有终端现在的后台 agent（界面启动时取一次，之后靠 subagents.changed）。一个都没有的终端不列。 */
  list(): Promise<TerminalBackgroundAgents[]>;
  /** 开始跟一个后台 agent 的记录：返回当前内容，之后有新行发 subagents.transcript-changed。重复调用没有副作用。 */
  watchTranscript(terminalId: TerminalId, agentId: string): Promise<BackgroundAgentTranscript>;
  /** 记录窗口关掉时调，不留监听。 */
  unwatchTranscript(terminalId: TerminalId, agentId: string): Promise<void>;
}

export type SubagentEvent =
  | { type: 'subagents.changed'; agents: TerminalBackgroundAgents }
  | { type: 'subagents.transcript-changed'; transcript: BackgroundAgentTranscript };
