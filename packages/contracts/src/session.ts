// AgentDeck 自己的 Session（M9 · SE0，需求见设计画布“Session”页 S0、S1，调研 DR-68）。
// 一条 Session = 在 AgentDeck 里开过的一条做事的线：一家 agent、一个目录，有父 session 和来历。
// 它比窗口活得长（关掉窗口进程停掉，Session 留下，Reopen 开回同一条），比 agent 的会话 id 稳（/clear、compact 算同一条的新一段）。
// 存在 SQLite（packages/store，SE1）；服务在 apps/desktop 主进程（SE2）。服务不知道窗口：窗口和 Session 的对应只存在白板上
// （TerminalWindowData.session）。所有开终端的入口都经过 agents.start，漏带 session 时服务兜底新建一条。
// 不转换各家的对话格式：换一家接着做（handoff）是开一条子 session，第一条消息是交接说明。

import type {
  AbsPath,
  AgentKind,
  AgentSessionId,
  CrewId,
  CrewTaskId,
  IsoTime,
  SessionId,
  TermSize,
  TerminalId,
  WorkspaceId,
} from './common.ts';

/** 集群里的角色（CR0、CR13）。Session 的 origin 和 crew.ts 共用这一份。 */
export type CrewRole = 'lead' | 'worker' | 'reviewer' | 'integrator' | 'qa';

/**
 * 这条 Session 是怎么开出来的（父是谁见 Session.parentId）：
 * - user：你从菜单、⌘T 开的，没有父。
 * - spawn：agent 用 MCP（open_terminal、open_terminals、create_workspace）或 agentdeck 命令行开的，tool 是工具名或 'cli'；父是调用者。
 * - fork：Fork into…，父是被 fork 的那条；AgentDeck 没记过它时 parentId 为 null，只记 agent 的会话 id。
 * - handoff：Hand off to ▸，父是上一家。
 * - crew：集群调度器派的活，父是集群的总设计（Lead）。taskId 为 null 是 Lead 自己或自由模式的子 session。
 * - forge：从 issue / PR 开的（M17 · FG0）：仓库（例如 'owner/name'）、做什么、issue 或 PR 的编号。
 * - adopted：历史栏里 Resume 一条 AgentDeck 没记过的会话（普通终端、Claude 桌面版里开的），第一次收进来。
 */
export type SessionOrigin =
  | { kind: 'user' }
  | { kind: 'spawn'; tool: string }
  | { kind: 'fork'; agentSessionId: AgentSessionId | null }
  | { kind: 'handoff' }
  | { kind: 'crew'; crewId: CrewId; taskId: CrewTaskId | null; role: CrewRole }
  | { kind: 'forge'; repo: string; mode: 'work' | 'review' | 'triage'; number: number }
  | { kind: 'adopted' };

/** 一段对话为什么开始：start 新开，resume 接回，clear 是 /clear 之后，compact 是压缩之后，fork 是 fork 出来的；读不到为 unknown。 */
export type AgentSessionReason = 'start' | 'resume' | 'clear' | 'compact' | 'fork' | 'unknown';

/** 一条 Session 下面按先后挂的一段 agent 自己的会话记录（claude 的 jsonl、codex 的 rollout……）。 */
export interface AgentSessionSegment {
  id: AgentSessionId;
  startedAt: IsoTime;
  reason: AgentSessionReason;
}

/** running：有终端进程在跑；stopped：关掉窗口、进程退出、电脑重启；handed-off：交给了别的 session（窗口不自动关）。 */
export type SessionState = 'running' | 'stopped' | 'handed-off';

export interface Session {
  id: SessionId;
  agent: AgentKind;
  /** 在哪个工作区；散放为 null。 */
  workspaceId: WorkspaceId | null;
  cwd: AbsPath;
  parentId: SessionId | null;
  origin: SessionOrigin;
  /** 名字：open_terminals 的 labels、Rename、集群的 “Worker · T4” 这类。没有为 null。英文原样。 */
  label: string | null;
  /** agent 自己起的对话标题（同历史栏的 title）。不知道为 null。 */
  title: string | null;
  /** 按先后排；最后一段是现在（或最后一次）在用的。还没拿到 agent 会话 id 时为空数组。 */
  agentSessions: AgentSessionSegment[];
  /** 现在跑在哪个终端进程里；停了为 null。恢复、Reopen 时换新的，Session 不变。 */
  terminalId: TerminalId | null;
  state: SessionState;
  /** state 为 handed-off 时，接班的那条。 */
  handedOffTo: SessionId | null;
  /** 这条是交接开出来的（origin 为 handoff）时，发给它的交接说明。 */
  handoffNote: string | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

/** Hand off to ▸：开一条另一家（也可以是同一家）的子 session，第一条消息是 note。原来那条标成 handed-off，窗口不关。 */
export interface HandoffRequest {
  from: SessionId;
  agent: AgentKind;
  /** 交接说明，原样当第一条消息（界面上可以改过）。 */
  note: string;
  /** 新终端的行列数，同 StartAgentRequest.size。 */
  size?: TermSize;
}

/** handoff 的结果：新开的子 session 和它的终端。界面把新窗口放在旧窗口右边。 */
export interface HandoffResult {
  session: Session;
  terminalId: TerminalId;
  /** 存进 TerminalWindowData，同 StartAgentResult。 */
  cmd: string;
  args: string[];
}

export interface SessionListOptions {
  workspaceId?: WorkspaceId | null;
  state?: SessionState;
}

export interface SessionService {
  /** 所有 Session（新的在前）。左边栏和历史栏合起来用。 */
  list(opts?: SessionListOptions): Promise<Session[]>;
  /** 没有时抛 not-found。 */
  get(id: SessionId): Promise<Session>;
  /** 直接的子 session（按 createdAt 先后）。 */
  children(id: SessionId): Promise<Session[]>;
  /** 改名字；null 清掉。 */
  rename(id: SessionId, label: string | null): Promise<Session>;
  /** from 不存在抛 not-found；目标 agent 没装抛 command-not-found。 */
  handoff(req: HandoffRequest): Promise<HandoffResult>;
  /**
   * Hand off 对话框里 “Use AgentDeck’s summary” 的说明（英文）：分支、改了的文件、最后的输出、上一家会话记录的路径。
   * 规格只列了 handoff；拼说明放在服务里，界面和集群（CR8）共用一份，所以加了这一个方法。
   */
  handoffSummary(id: SessionId): Promise<string>;
}

/** 一条 Session 新建或变了（state、terminalId、agentSessions、label……）。带完整的新值。 */
export type SessionEvent = { type: 'session.changed'; session: Session };
