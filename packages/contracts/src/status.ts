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
  | { id: RequestId; ok: false; reason: 'couldnt-approve' | 'gone' | 'unsupported' };

/** P1：Approve all 和按工作区的 Auto-approve。 */
export interface ApprovalService {
  /** 每条请求发 agent 的“允许一次”按键，2 秒内状态没离开 needs-approval 就算 couldnt-approve。 */
  approve(ids: RequestId[]): Promise<ApproveResult[]>;
  setAutoApprove(workspaceId: WorkspaceId, on: boolean): Promise<void>;
  history(workspaceId: WorkspaceId, limit: number): Promise<ApprovalRecord[]>;
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
  | { type: 'approval.auto-approved'; record: ApprovalRecord };
