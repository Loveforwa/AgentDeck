// 第 11 点：packages/contracts/src/docs.ts 的草稿（P11-T-1，单独提交，只加不改）。
// 只是形状，名字和字段由 contracts 负责人定。第 13 点（序列图）可以直接用 CodeAnchor / AnchorState / CodeAnchorService。
// 依赖：common.ts 的 AbsPath、IsoTime、TerminalId、AgentKind；git.ts 的 GitService（下面加三个方法）。

import type { AbsPath, AgentKind, IsoTime, TerminalId } from './common.ts';

// ---------------- 文档窗口（白板上的一种窗口，type 'doc'） ----------------

/** WindowNode<DocWindowData>.data。随白板保存。 */
export interface DocWindowData {
  /** 文件的绝对路径。在框里时通常在这个工作区（worktree）里；也可以是 AgentDeck 数据目录里的只读文件（集群汇报）。 */
  path: AbsPath;
  /** read：渲染后的阅读视图（默认）；edit：源码编辑（CodeMirror，markdown 原文）。 */
  view: 'read' | 'edit';
  /** “Ask …”和“Send comments to …”发给谁。agentdeck doc open 打开时是调用者；从终端链接打开时是那个终端。 */
  linkedTerminal?: { terminalId: TerminalId; label: string } | null;
  /** 打开时滚到哪里。 */
  scrollTo?: { heading?: string; line?: number } | null;
  /** 同 BrowserWindowData.reloadToken：复用窗口打开同一文件时换一个新值。 */
  reloadToken?: number;
  /** 你上次看过的版本（内容哈希），用来标“你没看过的改动”。窗口失去焦点时更新。 */
  seenHash?: string | null;
}

export interface DocFile {
  path: AbsPath;
  text: string;
  /** 内容的 sha1，写回时当作 baseHash。 */
  hash: string;
  mtime: IsoTime;
  /** 在哪个 git 仓库（worktree 根），不在仓库里为 null。引用按它解析。 */
  repo: AbsPath | null;
  readOnly: boolean;
}

export type DocWriteResult =
  | { ok: true; hash: string }
  /** 磁盘上的文件在你读过之后被改了（多半是 agent）。theirs 是现在的内容，窗口做三方合并。 */
  | { ok: false; conflict: { theirs: DocFile } };

export interface DocService {
  read(path: AbsPath): Promise<DocFile>;
  /** baseHash 和磁盘对不上时不写，返回 conflict。写入用临时文件 + rename。 */
  write(path: AbsPath, text: string, opts: { baseHash: string }): Promise<DocWriteResult>;
  /** 开始盯一个文件（fs.watch + 去抖 200ms），有变化发 doc.changed。窗口关掉时 unwatch。 */
  watch(path: AbsPath): Promise<void>;
  unwatch(path: AbsPath): Promise<void>;
  /** 这个工作区里的 .md（git ls-files + 未跟踪的，排除 node_modules），给路径下拉用。 */
  list(root: AbsPath): Promise<{ path: AbsPath; title: string | null }[]>;
  /** 这次运行里的快照（每次磁盘变化、每次你保存各一份，最多 50 份），给 “Changes since you last looked” 和历史用。 */
  snapshots(path: AbsPath): Promise<{ hash: string; at: IsoTime; by: DocAuthor | null }[]>;
  snapshot(path: AbsPath, hash: string): Promise<string | null>;
}

/** 谁改的。只在认得出时填：自己保存是 me；agent 的 PostToolUse 钩子带着这个文件路径、时间对得上时是那个终端。 */
export type DocAuthor = { kind: 'me' } | { kind: 'agent'; terminalId: TerminalId; agent: AgentKind; label: string };

export type DocEvent =
  | { type: 'doc.changed'; path: AbsPath; hash: string; by: DocAuthor | null }
  | { type: 'doc.anchors'; path: AbsPath; summary: AnchorSummary }
  | { type: 'doc.comments'; path: AbsPath }
  | { type: 'doc.verify'; path: AbsPath; runId: string; done: number; total: number };

// ---------------- 代码锚点（第 11、13 点共用） ----------------

/**
 * 文档里的一处代码引用，由 parseCodeRefs 从 markdown 里读出（纯函数，放在 contracts 里，界面和服务共用一份，
 * 同 effectiveSkillSelection 的做法）。认这几种写法（都可以带反引号）：
 *   path:12  path:12-30  path:12:5  path#L12-L30（GitHub、claude 的 @path#L12-30）  path@<rev>:12（钉住版本）
 * 紧跟在后面的 `Symbol`（反引号里的标识符）算作这处引用的符号。
 */
export interface CodeAnchor {
  /** 仓库根目录下的相对路径（写成绝对路径的也收，按仓库根换算）。 */
  path: string;
  start?: number;
  end?: number;
  symbol?: string;
  /** path@<rev>:line 时的 rev（提交、标签）。钉住的引用不跟着代码走。 */
  rev?: string;
  /** 一行原文（序列图草稿里的 anchor.text）。文档引用不写，由服务在核对时记下。 */
  text?: string;
}

export interface CodeRef extends CodeAnchor {
  /** 在文档里的原文和位置（0 起的偏移），渲染和“Update line numbers”用。 */
  raw: string;
  at: { from: number; to: number; line: number };
  /** 没写在仓库里的东西：(new) 标了的计划文件、URL、带来源前缀的外部源码。不核对。 */
  kind: 'repo' | 'new' | 'external';
}

/**
 * ok：基准以来这几行没变。moved：内容没变、行号挪了（now 是新位置）。changed：这几行被改过，要重新看。
 * gone：文件、符号或这几行都找不到了。ambiguous：短路径对到了几个文件。outside：不在这个工作区（或文档不在仓库里）。
 */
export type AnchorState = 'ok' | 'moved' | 'changed' | 'gone' | 'ambiguous' | 'outside';

export interface ResolvedRef {
  ref: CodeRef;
  state: AnchorState;
  /** 现在在哪（moved、changed 时和原来不同）。 */
  now?: { path: string; start: number; end: number } | null;
  /** 拿哪个版本当“写的时候看到的代码”。顺序：钉住的 rev > 上次核对通过时记下的 > git blame 这一行文档的提交 > 工作区现在。 */
  baseline: { rev: string | null; source: 'pinned' | 'verified' | 'blame' | 'worktree' };
  /** ambiguous 时的候选，gone 时的原因（英文，给悬停卡片）。 */
  candidates?: string[];
  detail?: string;
}

export interface AnchorSummary {
  total: number;
  counts: Record<AnchorState, number>;
  checkedAt: IsoTime;
}

export interface CodeAnchorService {
  /** 按文档所在的 worktree 解析。refs 不给时解析整篇。 */
  resolve(docPath: AbsPath, refs?: CodeRef[]): Promise<{ refs: ResolvedRef[]; summary: AnchorSummary }>;
  /** 悬停卡片：现在的代码（前后各 3 行），changed 时附上基准 → 现在的 diff。 */
  peek(docPath: AbsPath, ref: CodeRef): Promise<{ lines: { n: number; text: string }[]; diff: string | null }>;
  /** 只改 moved 的行号（其余不动），作为一次普通的文件写入，走 DocService.write。返回改了几处。 */
  fixLines(docPath: AbsPath, refs: CodeRef[]): Promise<number>;
  /** 把这几处记成“核对过”：记下现在的 blob 和这几行的哈希，之后以它为基准。 */
  markVerified(docPath: AbsPath, refs: CodeRef[]): Promise<void>;
}

/** 纯函数，界面和服务共用。 */
export declare function parseCodeRefs(markdown: string): CodeRef[];

// GitService 要加的（git-service 实现，只加不改）：
//   blameLines(repo, path, opts?: { rev?: string }): Promise<{ line: number; commit: string }[]>   // git blame --porcelain
//   showFile(repo, rev, path): Promise<string | null>                                              // git show rev:path
//   lineMap(repo, path, from: string, to: 'worktree' | string): Promise<LineMapHunk[]>             // git diff -U0 from [to] -- path
// export interface LineMapHunk { oldStart: number; oldLines: number; newStart: number; newLines: number }

// ---------------- 评论 ----------------

export interface DocComment {
  id: string;
  path: AbsPath;
  /** 评论挂在哪几个字上：W3C Web Annotation 的 TextQuoteSelector（exact + prefix + suffix），外加创建时的偏移当提示。 */
  anchor: { exact: string; prefix: string; suffix: string; hint: number } | null;
  body: string;
  author: DocAuthor;
  /** open：还没处理；sent：已发给 agent；addressed：agent 回了 --done；resolved：你点了 Resolve；detached：挂的字被删掉了。 */
  state: 'open' | 'sent' | 'addressed' | 'resolved' | 'detached';
  replies: { body: string; author: DocAuthor; at: IsoTime }[];
  at: IsoTime;
}

export interface DocCommentService {
  list(path: AbsPath, opts?: { open?: boolean }): Promise<DocComment[]>;
  add(path: AbsPath, c: Pick<DocComment, 'anchor' | 'body'>): Promise<DocComment>;
  reply(id: string, body: string, opts?: { done?: boolean }): Promise<void>;
  resolve(id: string): Promise<void>;
  /** 把这几条发给一个终端：拼一行英文提示词，终端空闲时发（发送方式同 PL3，不往等你的终端里打字，IS-102）。 */
  send(ids: string[], to: TerminalId): Promise<{ queued: boolean }>;
}

// ---------------- 语义核查 ----------------

export type ClaimVerdict = 'supported' | 'partly' | 'wrong' | 'unclear';

export interface DocClaim {
  /** 文档里一句（或一条列表项）+ 它带的引用。id 是“这句话的文字 + 引用”的哈希，文字或代码变了就是新的。 */
  id: string;
  text: string;
  refs: CodeRef[];
  verdict: {
    result: ClaimVerdict;
    reason: string;
    fix: string | null;
    by: { agent: AgentKind; terminalId: TerminalId };
    at: IsoTime;
    /** 核查时这几处代码的哈希。哪个变了，这条结论就作废。 */
    codeHashes: string[];
  } | null;
}

export interface DocVerifyService {
  /** 抽出要核查的句子（带引用的句子），已有有效结论的不算。给对话框显示数量和估算。 */
  plan(path: AbsPath): Promise<{ claims: DocClaim[]; toCheck: number; estimateTokens: number }>;
  /** 开一个核查终端（默认换一家：作者是 claude 就用 codex），只读，第一条提示词里只有句子和代码，没有作者的对话。 */
  start(path: AbsPath, opts: { agent: AgentKind; claimIds?: string[] }): Promise<{ runId: string; terminalId: TerminalId }>;
  /** agentdeck doc verdict 走这里。 */
  submit(runId: string, claimId: string, v: { result: ClaimVerdict; reason: string; fix?: string | null }): Promise<void>;
  claims(path: AbsPath): Promise<DocClaim[]>;
}
