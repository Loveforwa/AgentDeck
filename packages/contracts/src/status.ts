// 终端状态和“等你处理”的请求。需求见「6 · 终端状态与提醒」。
// 实现：packages/agent-adapters 里的 status 模块（线 4），运行在主进程，
// 输入是钩子事件（agent.ts）和 tmux 的 activity / silence / exit（terminal.ts）。

import type { AgentKind, AgentSessionId, IsoTime, RequestId, TerminalId, WorkspaceId } from './common.ts';

export type TerminalStatus =
  | 'starting' // 刚创建，还没有任何输出
  | 'running' // 收到 prompt-submitted，或有新输出
  | 'needs-approval' // 收到 permission-request
  | 'needs-reply' // agent 用提问工具问你；一轮说完不算
  | 'idle' // 一轮结束；没有钩子的程序 3 秒没有输出
  | 'exited' // 进程以 0 退出
  | 'error'; // 进程以非 0 退出，或启动失败

/** 这些状态算“在等你”，计入顶栏的 waiting 和 ⌘J 跳转。 */
export const WAITING_STATUSES: readonly TerminalStatus[] = ['needs-approval', 'needs-reply'];

export interface PendingRequest {
  id: RequestId;
  terminalId: TerminalId;
  workspaceId: WorkspaceId | null;
  agent: AgentKind;
  kind: 'approval' | 'question';
  /** 给人看的一句话，英文原文，例如 "pnpm test"。 */
  summary: string;
  command: string | null;
  /** 命中 Settings › Approvals 的破坏性名单。Approve all 里默认不勾。 */
  destructive: boolean;
  at: IsoTime;
}

export interface StatusSnapshot {
  terminalId: TerminalId;
  status: TerminalStatus;
  /** 进入当前状态的时间，标题栏写“Running · 4m”用。 */
  since: IsoTime;
  exitCode: number | null;
  /** status 为 needs-approval / needs-reply 时有值。 */
  pending: PendingRequest | null;
  /** 终端所在的工作区；散放为 null。面板据此知道这个目录里有哪些 agent 在跑。 */
  workspaceId?: WorkspaceId | null;
  /**
   * agent 自己的会话 id。claude 启动时就知道；codex 要等 SessionStart 钩子（实测在第一次输入之后）。
   * 界面拿到后存进 TerminalWindowData.sessionId，恢复会话和 Fork 用。
   */
  sessionId?: AgentSessionId | null;
}

export interface StatusService {
  /** 所有终端的当前状态。界面启动时取一次，之后靠 status.changed。 */
  snapshot(): Promise<StatusSnapshot[]>;
}

export type ApproveResult =
  | { id: RequestId; ok: true }
  /** destructive（PL1 加）：命中破坏性名单，按 ApproveOptions.includeDestructive 没有批准，也没发按键。 */
  | { id: RequestId; ok: false; reason: 'couldnt-approve' | 'gone' | 'unsupported' | 'destructive' };

/** approve 的可选参数（PL1 加）。 */
export interface ApproveOptions {
  /** 记进 ApprovalRecord.by。不填时一条算 'user'，多条算 'approve-all'。 */
  by?: 'user' | 'approve-all';
  /** 是否批准命中破坏性名单的请求。不填时 by 为 'user' 算 true，'approve-all' 算 false（顶栏 Approve all 里用户勾上的要传 true）。 */
  includeDestructive?: boolean;
}

/**
 * Approve all（X3）和 Auto-approve（PL1）。
 * Auto-approve 可以开在工作区框上（框里所有终端，包括之后新开的），也可以开在单个终端上；
 * 单个终端的设置优先于框的。开着时只替你回“允许一次”，选择题、要你打字回答的、破坏性命令照常等你。
 * 运行时以主进程这里为准；随白板保存的是 FrameNode.autoApprove 和 TerminalWindowData.autoApprove，重开应用时由组装按它们恢复。
 */
export interface ApprovalService {
  /** 每条请求发 agent 的“允许一次”按键，2 秒内状态没离开 needs-approval 就算 couldnt-approve。opts 是 PL1 加的。 */
  approve(ids: RequestId[], opts?: ApproveOptions): Promise<ApproveResult[]>;
  /**
   * 整个工作区框的开关。会清掉框里终端单独的设置（框上关掉 = 框里的都关；打开 = 框里的都开）。
   * 打开时，框里已经在等的、不是破坏性的批准请求马上按“允许一次”。
   */
  setAutoApprove(workspaceId: WorkspaceId, on: boolean): Promise<void>;
  history(workspaceId: WorkspaceId, limit: number): Promise<ApprovalRecord[]>;
  /**
   * PL1：单个终端的开关。true 单独开，false 单独关（框开着也不替它按），null 去掉单独设置、跟着框。
   * 打开时，它已经在等的、不是破坏性的批准请求马上按“允许一次”。
   */
  setTerminalAutoApprove(terminalId: TerminalId, on: boolean | null): Promise<void>;
  /** PL1：现在哪些框、终端开着。界面启动时取一次，之后靠 approval.auto-approve-changed。 */
  autoApproveState(): Promise<AutoApproveState>;
  /** PL1：每种 agent 能不能开、怎么替它按。右键菜单据此灰掉不支持的 agent。 */
  autoApproveSupport(): Promise<AutoApproveSupport[]>;
  /** PL1：开着 Auto-approve、但现在要你自己处理的终端和原因。界面启动时取一次，之后靠 approval.needs-you。 */
  autoApproveNeedsYou(): Promise<AutoApproveNeedsYou[]>;
}

/**
 * PL1：开着 Auto-approve 的终端为什么还在等你（书签变成 “Needs you”）。
 * destructive：命中破坏性名单；question：选择题或要你打字回答；couldnt-approve：发了“允许一次”但 2 秒内没生效；
 * unsupported：这个 agent 的请求没法替你按。
 */
export type AutoApproveNeedsYouReason = 'destructive' | 'question' | 'couldnt-approve' | 'unsupported';

export interface AutoApproveNeedsYou {
  terminalId: TerminalId;
  reason: AutoApproveNeedsYouReason;
  /** 在等的那条请求。 */
  request: PendingRequest;
}

/** PL1：Auto-approve 的开关状态。 */
export interface AutoApproveState {
  /** 开着的工作区框，和从什么时候开着。 */
  workspaces: { workspaceId: WorkspaceId; since: IsoTime }[];
  /** 单独设置过的终端。on 为 false：它在开着的框里，但单独关掉了。 */
  terminals: { terminalId: TerminalId; on: boolean; since: IsoTime }[];
}

/** PL1：一个终端实际开没开 Auto-approve（单独设置优先，其次看它所在的框）。 */
export function isAutoApproveOn(state: AutoApproveState, terminalId: TerminalId, workspaceId: WorkspaceId | null): boolean {
  const own = state.terminals.find((t) => t.terminalId === terminalId);
  if (own) return own.on;
  return workspaceId !== null && state.workspaces.some((w) => w.workspaceId === workspaceId);
}

/** PL1：某种 agent 的 Auto-approve 怎么做。 */
export interface AutoApproveSupport {
  agent: AgentKind;
  /**
   * hook：钩子直接回“允许一次”（claude、codex）；keys：看屏幕认出确认框后发按键（kimi、omp）；
   * never-asks：这个 agent 从来不请求批准，开着也没事可做（pi）；unsupported：不能开（shell、自定义命令）。
   */
  method: 'hook' | 'keys' | 'never-asks' | 'unsupported';
  /** 在真终端里核对过。false 时界面可以提示还没核对。 */
  verified: boolean;
  /** 给界面的一句话（英文），例如 "pi never asks for approval"、"Not supported for shell"。 */
  note: string | null;
}

export interface ApprovalRecord {
  request: PendingRequest;
  by: 'user' | 'approve-all' | 'auto-approve';
  at: IsoTime;
}

export type StatusEvent =
  | { type: 'status.changed'; snapshot: StatusSnapshot }
  /** 一轮结束。源代码管理面板据此刷新（不监听文件）。只对有“一轮”的 agent 发；Shell、自定义命令停下来不发。 */
  | { type: 'agent.turn-end'; terminalId: TerminalId; workspaceId: WorkspaceId | null }
  | { type: 'approval.auto-approved'; record: ApprovalRecord }
  /** PL1：开关变了（任何一个框或终端）。带完整的新状态。 */
  | { type: 'approval.auto-approve-changed'; state: AutoApproveState }
  /**
   * PL1：开着 Auto-approve 的终端开始要你处理（reason 有值），或者处理完了、开关关了（reason 为 null）。
   * 只在变化时发。终端照常进 needs-approval / needs-reply，⌘J 照常能找到它。
   */
  | { type: 'approval.needs-you'; terminalId: TerminalId; reason: AutoApproveNeedsYouReason | null; request: PendingRequest | null };
