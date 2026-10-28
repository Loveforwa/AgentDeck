// Agent 集群（M8 · CR0，需求见设计画布“Agent 集群”页 C0–C9，调研 DR-64、DR-65、DR-71～DR-73）。
// 两种模式：template 按模板（第一期只有 Contract-first build）由调度器派活；free（No template）只开一个 Lead，
// 它按需开子 session，AgentDeck 只守安全和记账的规矩（谁能开、上限、哪几家、worktree、收件箱、合回 main 永远你点）。
// 集群、任务表、子 session 表、Decisions 都存在 AgentDeck 的数据里（SQLite），不往仓库写。
// 调度器是 AgentDeck 里的代码（packages/crew-service），不是 agent。agent 经 agentdeck 命令行（cli.ts）和它打交道。
//
// 带 caller 参数的方法是命令行（mcp-server 的 /cli）替某个终端调的：服务按 caller 认出集群和角色（membership），
// 不是这个集群的 Lead 就拒绝（invalid-argument，message 是一句能照着做的英文，例如 "Only the lead of crew “login-fix” can open sessions."）。
// 界面不调这些方法。

import type {
  AbsPath,
  AgentKind,
  CrewId,
  CrewTaskId,
  IsoTime,
  ProjectId,
  SessionId,
  TerminalId,
  WorkspaceId,
} from './common.ts';
import type { CrewRole } from './session.ts';
import type { InboxItemId } from './inbox.ts';

export type CrewMode = 'template' | 'free';

/**
 * 集群的状态：planning 总设计在写任务表（模板）；running 在跑；paused 你点了 Pause crew（做完这一轮就停，不派新的）；
 * waiting-limit 额度用完在等恢复；ready-to-merge 做完了、等你 Merge into main；merged 合回 main 了；stopped 你点了 Stop 或到了 Stop after。
 */
export type CrewState = 'planning' | 'running' | 'paused' | 'waiting-limit' | 'ready-to-merge' | 'merged' | 'stopped';

/** 模板里一个角色用哪几家：按顺序，前一家额度用完时交给后一家接着做。count 是这个角色最多几个（Workers up to 3）。 */
export interface CrewRoleAssignment {
  role: CrewRole;
  agents: AgentKind[];
  count: number;
}

/** 模板模式的上限（New crew 的 LIMITS）。 */
export interface CrewLimits {
  /** 同时最多几个干活的 agent（空着的 Lead 不占位），默认 3。 */
  maxAtOnce: number;
  /** 最长跑多久（分钟）；null 不限。规格写 stopAfter，单位定成分钟。 */
  stopAfter: number | null;
  /** 额度用完时等恢复再接着派。 */
  waitForLimits: boolean;
  keepAwake: boolean;
}

/**
 * 关卡的种类（Ask me 里的项）：approve-plan 确认任务表；interface-change 改锁住的接口；before-merge 每次合进集群分支前；
 * stuck 任务失败两次（总是问）；merge-into-main 合回 main（总是问，不能关）；lead-ask Lead 跑 crew ask 问你（自由模式，总是问）；
 * locked-path 改到了 Locked paths（自由模式，总是问）。
 */
export type CrewGateKind =
  | 'approve-plan'
  | 'interface-change'
  | 'before-merge'
  | 'stuck'
  | 'merge-into-main'
  | 'lead-ask'
  | 'locked-path';

/** 自由模式的设置（New crew 选 No template）。 */
export interface CrewFreeSettings {
  /** Lead 能开的几家（SUBAGENTS THE LEAD MAY OPEN）。 */
  allowedAgents: AgentKind[];
  /** 同时最多几个子 session（Lead 不算），默认 3，超了直接拒绝。 */
  maxAtOnce: number;
  /** 检查命令，可选：Lead 叫才跑，Ready to merge 时在集群分支跑一次给你看，不拦。 */
  check?: string | null;
  /** 合进集群分支时碰到这些路径就进收件箱（glob，例如 'packages/contracts/**'）。默认空。 */
  lockedPaths?: string[];
  /** 最长跑多久（分钟）；null 不限。 */
  stopAfter: number | null;
  keepAwake: boolean;
  /** 每个 agent 开着 Auto-approve（PLUGINS FOR EVERY AGENT）。 */
  autoApprove: boolean;
  /** 子 session 默认各自一个 worktree（Each in its own worktree）；false 时默认共用 Lead 的目录。 */
  ownWorktree?: boolean;
}

export interface Crew {
  id: CrewId;
  /** 例如 'history-sidebar'；集群分支是 crew/<name>。 */
  name: string;
  projectId: ProjectId;
  /** 集群自己的 worktree（集群分支）对应的工作区。 */
  workspaceId: WorkspaceId | null;
  mode: CrewMode;
  /** 模板 id，例如 'contract-first-build'；自由模式为 null。 */
  template: string | null;
  goal: string;
  /** 集群分支，例如 'crew/history-sidebar'。 */
  branch: string;
  /** 从哪个分支切出来（START FROM）。 */
  baseBranch: string;
  /** 模板模式的分工；自由模式只有 Lead 一行。 */
  roles: CrewRoleAssignment[];
  /** 每次交付后调度器自己跑的检查命令（模板模式）；自由模式见 free.check。 */
  check: string | null;
  limits: CrewLimits;
  /** 开着的关卡种类（Ask me）。stuck、merge-into-main（模板）和 lead-ask、locked-path、merge-into-main（自由）总在里面。 */
  askMe: CrewGateKind[];
  /** THE LEAD：suggest 先给 worker 的问题写建议（默认开）；answer 替你答 worker 的问题（第二期，默认关）。 */
  leadMay: { suggest: boolean; answer: boolean };
  /** 自由模式的设置；模板模式为 null。 */
  free: CrewFreeSettings | null;
  state: CrewState;
  /** 模板模式的阶段，例如 'Build · wave 2 of 3'（英文，界面原样显示）；自由模式为 null。 */
  stage: string | null;
  /** 总设计 / Lead 的 Session。还没开为 null。 */
  leadSession: SessionId | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

/** 任务的状态，只由调度器改（C3 第 1 节）。 */
export type CrewTaskStatus =
  | 'waiting'
  | 'ready'
  | 'working'
  | 'check'
  | 'review'
  | 'merge'
  | 'merged'
  | 'stuck'
  | 'needs-you'
  | 'paused';

/** 任务上的一个 session：按先后排；交接后接着做的那条是前一条的子 session（Session.parentId）。 */
export interface CrewTaskSession {
  sessionId: SessionId;
  role: Exclude<CrewRole, 'lead'>;
}

export interface CrewTask {
  id: CrewTaskId;
  crewId: CrewId;
  title: string;
  /** 依赖的任务。 */
  needs: CrewTaskId[];
  /** 这个任务负责的目录（glob，例如 'packages/ui/panels/history/**'）。改了以外的文件会被打回。 */
  owns: string[];
  doneWhen: string;
  wave: number;
  status: CrewTaskStatus;
  /** 第几轮（检查或审查打回一次加一）。 */
  round: number;
  /** 任务的 worktree，还没开为 null。分支是 crew/<name>/<id>。 */
  worktree: AbsPath | null;
  sessions: CrewTaskSession[];
}

/** 一个关卡。处理过的 resolved 有值，同时记一条 CrewDecision。 */
export interface CrewGate {
  id: string;
  crewId: CrewId;
  kind: CrewGateKind;
  /** 和哪个任务有关（interface-change、stuck、locked-path）；没有为 null。 */
  taskId: CrewTaskId | null;
  /** 一句话，英文，例如 "Lead wrote 8 tasks in 3 waves. Nothing starts until you approve."。 */
  summary: string;
  /** 细节：接口改动的理由、碰到的路径、问题原文。没有为 null。 */
  detail: string | null;
  /** 收件箱里对应的那一条。 */
  inboxItem: InboxItemId | null;
  openedAt: IsoTime;
  resolved: { approved: boolean; note: string | null; at: IsoTime } | null;
}

/** 子 session 现在怎样（session wait 等的就是这几种）：closed 是 Lead 关掉了。 */
export type CrewSessionStatus = 'running' | 'idle' | 'needs-you' | 'error' | 'exited' | 'limited' | 'closed';

/**
 * 集群里的一个子 session（建在 SE0 的 Session 上，两种模式共用；模板模式的任务也通过它挂 Worker、Reviewer）。
 * 自由模式的子 session 表就是这些。
 */
export interface CrewSession {
  sessionId: SessionId;
  crewId: CrewId;
  /** Lead 起的标签，例如 'race'；同一集群里不重复。 */
  label: string;
  agent: AgentKind;
  workspaceId: WorkspaceId | null;
  /** own：自己的 worktree（crew/<name>/<label>）；shared：共用 Lead 的目录。 */
  worktree: 'own' | 'shared';
  /** 分支；shared 时是 Lead 的分支。 */
  branch: string;
  owns?: string[];
  /** Lead 写的交接提示词（AgentDeck 前面加的固定几行不算）。 */
  firstPrompt: string;
  status: CrewSessionStatus;
  spawnedAt: IsoTime;
  closedAt?: IsoTime | null;
  /** 合进集群分支的时间。 */
  mergedAt?: IsoTime | null;
  /** 会话记录里最后一条完整回复（session result）。没读到为 null。 */
  lastResult?: string | null;
}

/** 你（或 Auto-approve、Lead）处理过的一条，集群的“短期记忆”（C8）。 */
export interface CrewDecision {
  id: string;
  crewId: CrewId;
  /** 条目：收件箱那一条或关卡的 id，加上它的标题（例如 'Approve plan'、'Question'）。 */
  item: { id: string; title: string };
  /** 问的人，例如 'QA · codex'、'T7 · codex'、'Lead · claude'。英文原样。 */
  askedBy: string;
  question: string;
  answer: string;
  by: 'user' | 'auto-approve' | 'lead';
  /** 答案是谁先建议的（Lead suggests）。没有为 null。 */
  suggestedBy: 'lead' | null;
  at: IsoTime;
}

/** “这个终端在哪个集群、什么角色”（CR13、CR14 用）。 */
export interface CrewMembership {
  crewId: CrewId;
  mode: CrewMode;
  role: CrewRole;
  sessionId: SessionId;
  /** 模板模式的任务；Lead 和自由模式的子 session 为 null。 */
  taskId: CrewTaskId | null;
}

export interface CreateCrewRequest {
  projectId: ProjectId;
  name: string;
  mode: CrewMode;
  /** 模板模式必填；自由模式不填。 */
  template?: string;
  goal: string;
  baseBranch: string;
  roles: CrewRoleAssignment[];
  check?: string | null;
  limits: CrewLimits;
  askMe: CrewGateKind[];
  leadMay?: { suggest: boolean; answer: boolean };
  /** 自由模式必填。 */
  free?: CrewFreeSettings;
}

/** crew status 的结果（自由模式 Lead 压缩上下文后靠它找回来）。 */
export interface CrewStatus {
  crew: Crew;
  /** 模板模式的任务表；自由模式为空数组。 */
  tasks: CrewTask[];
  sessions: CrewSession[];
  /** 位置：在用几个、最多几个。 */
  slots: { used: number; max: number };
  /** 和 digest 同一段文字（代码生成，最多约 1.5K token）。 */
  digest: string;
}

/** session spawn（就是 open）：只有 Lead；不超上限；只开允许的几家；提示词前 AgentDeck 加几行固定说明。 */
export interface CrewSpawnRequest {
  agent: AgentKind;
  label: string;
  prompt: string;
  /** 不填按 CrewFreeSettings.ownWorktree（默认 own）。 */
  worktree?: 'own' | 'shared';
  owns?: string[];
}

/** 子 session 的引用：标签（'race'）或 SessionId。 */
export type CrewSessionRef = string;

/** session wait：等一个（target）、任一（any）或全部（all）。 */
export interface CrewWaitRequest {
  mode: 'one' | 'any' | 'all';
  /** mode 为 one 时必填。 */
  target?: CrewSessionRef;
  /** 不填等 10 分钟。 */
  timeoutMs?: number;
}

export interface CrewWaitResult {
  /** 停下来的子 session 和为什么停（idle 做完、needs-you 在等你、error、exited、limited 碰到额度上限）。 */
  stopped: { label: string; sessionId: SessionId; status: Exclude<CrewSessionStatus, 'running' | 'closed'> }[];
  /** 还在跑的标签。 */
  running: string[];
  timedOut: boolean;
}

/** crew check：在 worktree 里跑检查命令（命令是 New crew 里填的，Lead 换不了）。 */
export interface CrewCheckResult {
  ok: boolean;
  exitCode: number;
  /** 输出的最后一段。 */
  output: string;
}

/**
 * crew merge：merge --no-ff 进集群分支。merged 合进去了；conflict 有冲突，files 是冲突的文件（之后 --continue 或 --abort）；
 * gate 碰到 Locked paths，进了收件箱等你；aborted 是 --abort 之后。
 */
export type CrewMergeResult =
  | { state: 'merged'; commit: string }
  | { state: 'conflict'; files: string[] }
  | { state: 'gate'; gateId: string; paths: string[] }
  | { state: 'aborted' };

export interface CrewService {
  // ---- 界面用 ----
  create(req: CreateCrewRequest): Promise<Crew>;
  list(projectId?: ProjectId): Promise<Crew[]>;
  get(id: CrewId): Promise<Crew>;
  pause(id: CrewId): Promise<Crew>;
  /** 继续（Pause 之后）。 */
  resume(id: CrewId): Promise<Crew>;
  /** Stop：出汇报，任务 worktree 清掉，分支都留着。 */
  stop(id: CrewId): Promise<Crew>;
  /** 读任务表（模板模式；自由模式为空数组）。 */
  tasks(id: CrewId): Promise<CrewTask[]>;
  /** 子 session 表。 */
  sessions(id: CrewId): Promise<CrewSession[]>;
  /** 关卡（不给 open 时含处理过的）。 */
  gates(id: CrewId, opts?: { open?: boolean }): Promise<CrewGate[]>;
  /**
   * 处理关卡（只能你在界面上点；命令行没有这个）。merge-into-main 批准后合回 main。
   * 关卡已经处理过抛 invalid-argument。处理完记一条 CrewDecision。
   */
  resolveGate(gateId: string, decision: { approved: boolean; note?: string | null }): Promise<CrewGate>;
  /** 进度摘要：AgentDeck 的代码按固定格式生成（不是模型写的），英文；since 只给这之后变了什么。 */
  digest(crewId: CrewId, since?: IsoTime): Promise<string>;
  decisions(crewId: CrewId): Promise<CrewDecision[]>;
  /** 这个终端在哪个集群、什么角色；不在集群里返回 null。 */
  membership(terminalId: TerminalId): Promise<CrewMembership | null>;

  // ---- 命令行替终端调（agentdeck crew … / agentdeck session …），caller 是发起的终端 ----
  status(caller: TerminalId, opts?: { since?: IsoTime }): Promise<CrewStatus>;
  spawn(caller: TerminalId, req: CrewSpawnRequest): Promise<CrewSession>;
  /** 给子 session 发一条消息；它在跑时返回 busy，在等你时返回 waiting-for-user（不往等你的终端里打字，IS-102）。 */
  send(caller: TerminalId, target: CrewSessionRef, text: string): Promise<'sent' | 'busy' | 'waiting-for-user'>;
  /** 屏幕最后几行。 */
  read(caller: TerminalId, target: CrewSessionRef, lines?: number): Promise<string[]>;
  /** 会话记录里最后一条完整回复；读不到会话记录退回屏幕（source 为 screen）。 */
  result(caller: TerminalId, target: CrewSessionRef): Promise<{ text: string | null; source: 'transcript' | 'screen' }>;
  wait(caller: TerminalId, req: CrewWaitRequest): Promise<CrewWaitResult>;
  /** 相对集群分支的改动（统一 diff）。不给 target 是调用者自己的 worktree。 */
  diff(caller: TerminalId, target?: CrewSessionRef): Promise<string>;
  check(caller: TerminalId, target?: CrewSessionRef): Promise<CrewCheckResult>;
  merge(caller: TerminalId, target: CrewSessionRef, opts?: { continue?: boolean; abort?: boolean }): Promise<CrewMergeResult>;
  /** 关掉子 session 的终端（只能关自己开的；worktree 留到集群结束）。 */
  close(caller: TerminalId, target: CrewSessionRef): Promise<void>;
  /** 问你（进收件箱，回答原样发回调用者的终端）。返回收件箱那一条的 id。 */
  ask(caller: TerminalId, question: string, options?: string[]): Promise<InboxItemId>;
  /** 记一条发现（进汇报，Lead 和后开的任务读得到）。 */
  note(caller: TerminalId, text: string): Promise<void>;
  /** 自由模式：目标达成。跑检查、出汇报、收件箱出 Ready to merge（合回 main 由你点）。模板模式：Worker 交付。 */
  done(caller: TerminalId, summary: string): Promise<void>;
}

/**
 * 集群的事件。都带完整的新值。
 * crew.session-spawned / -changed / -closed：子 session 表的变化（白板的侧边栏、worktree 小框跟着画）。
 */
export type CrewEvent =
  | { type: 'crew.changed'; crew: Crew }
  | { type: 'crew.task-changed'; task: CrewTask }
  | { type: 'crew.gate-changed'; gate: CrewGate }
  | { type: 'crew.decision-added'; decision: CrewDecision }
  | { type: 'crew.note-added'; crewId: CrewId; by: string; text: string; at: IsoTime }
  | { type: 'crew.session-spawned'; session: CrewSession }
  | { type: 'crew.session-changed'; session: CrewSession }
  | { type: 'crew.session-closed'; session: CrewSession };
