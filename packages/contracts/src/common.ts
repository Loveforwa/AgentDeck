// 所有包共用的基础类型：ID、时间、尺寸、错误。
// 这里只放类型和极少量纯函数，不放任何实现。

declare const brand: unique symbol;
/** 带标记的字符串，防止把 WorkspaceId 传进需要 TerminalId 的地方。 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectId = Brand<string, 'ProjectId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
/** 白板上一个窗口（终端、网页……）的 id。 */
export type WindowId = Brand<string, 'WindowId'>;
/** 一个 tmux 会话。等于 tmux 里的 session 名，也写进窗格的 AGENTDECK_TERM 环境变量。 */
export type TerminalId = Brand<string, 'TerminalId'>;
/** 一次“接上显示”。同一个终端断开再接上会得到新的 ViewId。 */
export type ViewId = Brand<string, 'ViewId'>;
/** agent 自己的会话 id，例如 claude 的 --session-id、codex 的 thread id。 */
export type AgentSessionId = Brand<string, 'AgentSessionId'>;
/** 一条“等你处理”的请求（批准或提问）。 */
export type RequestId = Brand<string, 'RequestId'>;
/** 白板上的一个窗口组（MVP v3 · N1、N2：agent 一次开出的子终端和开它们的主 agent）。N1 加。 */
export type WindowGroupId = Brand<string, 'WindowGroupId'>;

/** 内置的 agent，加上任意自定义命令。 */
export type AgentKind = 'claude' | 'codex' | 'gemini' | 'shell' | 'custom' | (string & {});

/** ISO 8601 时间字符串。 */
export type IsoTime = string;
/** 绝对路径。 */
export type AbsPath = string;

export interface Size {
  w: number;
  h: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface TermSize {
  cols: number;
  rows: number;
}

export type ErrorCode =
  | 'not-found'
  | 'invalid-argument'
  | 'not-a-git-repo'
  | 'branch-in-use' // 分支已经在另一个 worktree 里检出
  | 'branch-exists'
  | 'dirty-worktree' // 有未提交的更改，操作被拒绝
  | 'git-failed' // git 返回非 0，detail 里是 stderr
  | 'tmux-unavailable'
  | 'command-not-found'
  | 'unsupported' // 这个 agent 不支持该能力（例如 fork）
  | 'timeout'
  | 'cancelled'
  | 'internal';

/** 跨进程传递的错误。IPC 层把它还原成 AgentDeckError 抛给调用方。 */
export interface AgentDeckErrorData {
  code: ErrorCode;
  /** 给界面显示的一句话，英文。 */
  message: string;
  /** 原始输出，例如 git 的 stderr，界面里可以展开看。 */
  detail?: string;
}

export class AgentDeckError extends Error implements AgentDeckErrorData {
  readonly code: ErrorCode;
  readonly detail?: string;

  constructor(data: AgentDeckErrorData) {
    super(data.message);
    this.name = 'AgentDeckError';
    this.code = data.code;
    if (data.detail !== undefined) this.detail = data.detail;
  }

  toData(): AgentDeckErrorData {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail };
  }
}

export function isAgentDeckErrorData(value: unknown): value is AgentDeckErrorData {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

/** 取消订阅。 */
export type Unsubscribe = () => void;
