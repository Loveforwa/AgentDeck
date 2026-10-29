// 本包对外的仓储接口。只给主进程里的服务用，不经过 IPC，所以不放进 contracts。
// 仓储是同步的：better-sqlite3 本身是同步的，同步接口才能用 Store.transaction 把几步写入包进一个事务。

import type {
  AbsPath,
  AgentKind,
  AgentSessionId,
  AgentSessionSegment,
  ApprovalRecord,
  BoardStore,
  IsoTime,
  Project,
  ProjectId,
  Session,
  SessionId,
  SessionListOptions,
  SessionState,
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
  /** agent 自己的会话 id（列名 agent_session_id）。 */
  sessionId: AgentSessionId | null;
  /** SE1：这个终端跑的是哪条 Session（列名 session_id）。不填当 null。 */
  session?: SessionId | null;
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
  /**
   * IS-95：只留 keep 里的终端（tmux 里还在的），其余的记录删掉，返回删了几条。
   * 重开应用、拿到 TerminalHost.list() 之后调一次；拿不到列表时不要调（会把记录全删掉）。
   */
  prune(keep: readonly TerminalId[]): number;
}

export interface ApprovalRepository {
  add(record: ApprovalRecord): void;
  /** 这个工作区的记录，新的在前，最多 limit 条。 */
  history(workspaceId: WorkspaceId, limit: number): ApprovalRecord[];
}

/** SessionRepository.updateState 改哪几样；不填的保持原样。 */
export interface SessionStateChange {
  state?: SessionState;
  /** 停了为 null。 */
  terminalId?: TerminalId | null;
  /** 只在 state 为 handed-off 时留下；改成别的状态时清掉。 */
  handedOffTo?: SessionId | null;
  /** updatedAt，默认现在。 */
  at?: IsoTime;
}

/** AgentDeck 自己的 Session（SE1）。服务在 apps/desktop 的主进程（SE2），这里只管存。 */
export interface SessionRepository {
  /** 新的在前（createdAt）。 */
  list(opts?: SessionListOptions): Session[];
  get(id: SessionId): Session | null;
  /** 直接的子 session，按 createdAt 先后。 */
  listByParent(parentId: SessionId): Session[];
  /** 哪条 Session 下面挂着这段 agent 会话；有几条时取最近更新的。 */
  findByAgentSession(agent: AgentKind, agentSessionId: AgentSessionId): Session | null;
  /** 现在（或最后）跑在这个终端里的那条。 */
  findByTerminal(terminalId: TerminalId): Session | null;
  /** 有就整条更新（连同 agentSessions 分段），没有就插入。parentId、handedOffTo、workspaceId 必须指向已有的行（外键）。 */
  put(session: Session): void;
  /** 改 state、terminalId、handedOffTo。不存在返回 null，否则返回新值。 */
  updateState(id: SessionId, change: SessionStateChange): Session | null;
  /** 在最后加一段 agent 会话。不存在返回 null，否则返回新值。at 是 updatedAt，默认现在。 */
  addSegment(id: SessionId, segment: AgentSessionSegment, at?: IsoTime): Session | null;
  /** 删掉一条（分段一起删；子 session 的 parentId 变 null）。不存在返回 false。 */
  remove(id: SessionId): boolean;
}

/** doc_anchor_cache 的一行（M15 · DC2）。result 是 doc-service 自己定的 JSON，本包不解析。 */
export interface DocAnchorCacheRow {
  refKey: string;
  /** pinned:<rev> / verified:<blob> / blame:<commit> / worktree */
  baseline: string;
  /** 工作区里被引用文件的 sha1。 */
  targetHash: string;
  result: string;
  checkedAt: IsoTime;
}

/** Mark as checked 记下的一处引用：以那时的文件内容（blob）里的 start–end 行为基准。 */
export interface DocAnchorVerified {
  docPath: AbsPath;
  refKey: string;
  /** 相对仓库根。 */
  path: string;
  start: number;
  end: number;
  /** git 的 blob id（文件内容的哈希），全文存在 doc_anchor_blobs。 */
  blob: string;
  /** 这几行原文的 sha1。 */
  linesHash: string;
  verifiedAt: IsoTime;
}

/** 文档里代码引用的核对缓存和核对记录（迁移 3）。按文档的绝对路径，每个 worktree 一份。 */
export interface DocAnchorRepository {
  cache(docPath: AbsPath): DocAnchorCacheRow[];
  /** 整篇换成这几行（一个事务）。 */
  replaceCache(docPath: AbsPath, rows: DocAnchorCacheRow[]): void;
  verified(docPath: AbsPath): DocAnchorVerified[];
  /** 记下（或更新）几条核对记录和它们用到的全文；没有记录再用到的全文顺手删掉。 */
  putVerified(records: DocAnchorVerified[], blobs: { blob: string; text: string }[]): void;
  /** 改了行号（Update line numbers）以后记录跟着换 key；to 已有记录时被替换。 */
  moveVerified(docPath: AbsPath, from: string, to: string): void;
  blob(blob: string): string | null;
}

export interface Store {
  board: BoardStore;
  projects: ProjectRepository;
  workspaces: WorkspaceRepository;
  terminals: TerminalRepository;
  approvals: ApprovalRepository;
  sessions: SessionRepository;
  /** 文档里代码引用的核对缓存和核对记录（DC2）。 */
  docAnchors: DocAnchorRepository;
  /** 在一个事务里跑 fn，fn 抛错时全部回滚。fn 必须是同步的。可以嵌套（内层用 savepoint）。 */
  transaction<T>(fn: () => T): T;
  /** 当前数据库结构的版本号。 */
  schemaVersion(): number;
  close(): void;
}
