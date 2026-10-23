// 本包对外的仓储接口。只给主进程里的服务用，不经过 IPC，所以不放进 contracts。
// 仓储是同步的：better-sqlite3 本身是同步的，同步接口才能用 Store.transaction 把几步写入包进一个事务。

import type {
  AbsPath,
  AgentKind,
  AgentSessionId,
  ApprovalRecord,
  BoardStore,
  IsoTime,
  Project,
  ProjectId,
  TerminalId,
  TerminalStatus,
  WindowId,
  Workspace,
  WorkspaceId,
} from '@agentdeck/contracts';

export interface ProjectRepository {
  /** 最近用过的在前。 */
  list(): Project[];
  get(id: ProjectId): Project | null;
  /** 按文件夹找，probe 判断 already-added 用。 */
  findByPath(path: AbsPath): Project | null;
  /** 有就整条更新，没有就插入。path 和别的项目重复时抛 SqliteError（UNIQUE）。 */
  put(project: Project): void;
  /** 更新 lastUsedAt。项目不存在时返回 false。 */
  touch(id: ProjectId, at: IsoTime): boolean;
  /** 连同它的工作区、终端记录、批准记录一起删掉。不存在时返回 false。 */
  remove(id: ProjectId): boolean;
}

export interface WorkspaceRepository {
  /** 按创建时间先后。 */
  list(): Workspace[];
  listByProject(projectId: ProjectId): Workspace[];
  get(id: WorkspaceId): Workspace | null;
  /** 有就整条更新，没有就插入。项目必须已经存在（外键）。 */
  put(workspace: Workspace): void;
  /** 连同它的终端记录、批准记录一起删掉。不存在时返回 false。 */
  remove(id: WorkspaceId): boolean;
}

/** 一个终端的恢复信息，“恢复上次会话”用。字段和 TerminalWindowData 对应。 */
export interface TerminalRecord {
  terminalId: TerminalId;
  /** 窗口关掉后终端还在后台跑时为 null。 */
  windowId: WindowId | null;
  workspaceId: WorkspaceId | null;
  agent: AgentKind;
  cmd: string;
  args: string[];
  cwd: AbsPath;
  sessionId: AgentSessionId | null;
  startCommand: string | null;
  lastStatus: TerminalStatus;
  exitCode: number | null;
  updatedAt: IsoTime;
}

export interface TerminalRepository {
  /** 按更新时间，新的在前。 */
  list(): TerminalRecord[];
  listByWorkspace(workspaceId: WorkspaceId): TerminalRecord[];
  get(terminalId: TerminalId): TerminalRecord | null;
  getByWindow(windowId: WindowId): TerminalRecord | null;
  /**
   * 有就整条更新，没有就插入。同一个窗口原来记着别的终端时（重启后恢复会得到新的 terminalId），
   * 旧记录会被替换掉。
   */
  put(record: TerminalRecord): void;
  /** 记下最后状态。终端不存在时返回 false。at 默认现在。 */
  updateStatus(terminalId: TerminalId, status: TerminalStatus, exitCode: number | null, at?: IsoTime): boolean;
  /** 改 sessionId（session-start 钩子到了才知道）。终端不存在时返回 false。 */
  updateSession(terminalId: TerminalId, sessionId: AgentSessionId | null, at?: IsoTime): boolean;
  remove(terminalId: TerminalId): boolean;
}

export interface ApprovalRepository {
  add(record: ApprovalRecord): void;
  /** 这个工作区的记录，新的在前，最多 limit 条。 */
  history(workspaceId: WorkspaceId, limit: number): ApprovalRecord[];
}

export interface Store {
  board: BoardStore;
  projects: ProjectRepository;
  workspaces: WorkspaceRepository;
  terminals: TerminalRepository;
  approvals: ApprovalRepository;
  /** 在一个事务里跑 fn，fn 抛错时全部回滚。fn 必须是同步的。可以嵌套（内层用 savepoint）。 */
  transaction<T>(fn: () => T): T;
  /** 当前数据库结构的版本号。 */
  schemaVersion(): number;
  close(): void;
}
