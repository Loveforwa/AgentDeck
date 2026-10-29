// 白板的数据形状和保存。需求见「3 · 白板」「9 · 保存与重启」。
// 保存实现：packages/store（M0），运行在主进程，SQLite。白板界面：packages/ui/canvas（线 2）。

import type {
  AgentKind,
  AgentSessionId,
  CrewId,
  IsoTime,
  Rect,
  SessionId,
  Size,
  TermSize,
  TerminalId,
  Unsubscribe,
  WindowGroupId,
  WindowId,
  WorkspaceId,
} from './common.ts';
import type { SkillItemId } from './skills.ts';
import type { Workspace } from './workspace.ts';

export interface Viewport {
  x: number;
  y: number;
  /** 1 = 100%。只有 ⌘ + 滚轮会改它。 */
  zoom: number;
}

/** 白板上的一个工作区框。一个工作区在白板上最多一个框。 */
export interface FrameNode {
  workspaceId: WorkspaceId;
  rect: Rect;
  z: number;
  /** 按工作区开的 Auto-approve（P1）。 */
  autoApprove: boolean;
  /** 一键排版（MVP v3 · N12，画板 15）。老数据没有它，按 { auto: false, layout: null }。 */
  arrange?: FrameArrange;
  /**
   * PL4：框上的 Auto-resume。true / false 单独设过；不填或 null 跟着白板（BoardState.autoResume）。规格只写了终端一级，框和白板两级照设计画布第 7 节加。
   * @deprecated 2026-10-29 用户定：项目框上没有 Auto-resume 开关，这个字段不再读（只加不删，老白板里的值读得进来、不起作用）。
   */
  autoResume?: boolean | null;
}

/** CR0：白板上的一个集群框。框里的任务框就是普通的工作区框（FrameNode），终端是普通的终端窗口。 */
export interface CrewFrameNode {
  crewId: CrewId;
  rect: Rect;
  z: number;
  /** 折叠成只剩标题条。 */
  collapsed: boolean;
  /** 任务表看成表格还是看板（模板模式）。 */
  planView: 'table' | 'board';
}

/** 框里窗口的排法：tidy 紧凑网格（窗口大小不变）、columns 并排一样高、rows 上下叠一样宽。 */
export type FrameLayout = 'tidy' | 'columns' | 'rows';

export interface FrameArrange {
  /** 开着时在这个框里新开、关掉窗口都按 layout 重排（没点过排法时按 tidy）。 */
  auto: boolean;
  /** 最近一次点的排法；没点过为 null。 */
  layout: FrameLayout | null;
}

export interface WindowNode<TData = unknown> {
  id: WindowId;
  /** 在窗口注册表里的类型，例如 'terminal'、'browser'。 */
  type: string;
  /** 散放在白板上时为 null。终端创建后不能换框。 */
  workspaceId: WorkspaceId | null;
  rect: Rect;
  z: number;
  /** 用户用 Rename 起的名字；null 时显示默认标题。 */
  title: string | null;
  /** 放大前、或拉小成摘要卡前的位置，还原时用。两种不会同时出现。 */
  restoreRect: Rect | null;
  /** 打开时带的 OpenWindowRequest.reuseKey，随白板保存，重启后同一地址仍然复用这个窗口。 */
  reuseKey?: string | null;
  /**
   * 属于哪个窗口组（MVP v3 · N1、N2）：agent 用 MCP 的 open_terminals 一次开出的子终端，和开它们的主 agent。
   * 随白板保存，N2 的侧边栏据此列出一组里的子终端。没有组时不填或为 null。N1 加。
   * 关掉主 agent 的窗口时，子终端去掉这个字段，变回普通窗口；组里最后一个子终端关掉时，主 agent 的也去掉。
   */
  group?: WindowGroupRef | null;
  data: TData;
}

/**
 * 窗口在组里的身份。同一组的窗口 id 相同，一组只有一个 lead。N1 加。
 * SE0 起只管显示（N2 侧边栏的停靠和收起）：谁开了谁、算不算一组看 Session.parentId（session.ts），关掉 lead 时关系不丢。
 */
export interface WindowGroupRef {
  id: WindowGroupId;
  /** lead：开出这一组的主 agent；member：子终端（按在 BoardState.windows 里的先后排）。 */
  role: 'lead' | 'member';
  /** 子终端的名字，例如 'api'（open_terminals 的 labels）。主 agent、没给名字时为 null。英文原样，界面直接显示。 */
  label?: string | null;
  /**
   * 只在 lead 上（N2 侧边栏）：这一组子终端怎么显示，随白板保存。不填或 null 时按 { mode: 'all' }（N1 存下的组）。
   * 收起的子终端不画在白板上，进程照常运行，仍然算进“在等你”。
   */
  view?: WindowGroupView | null;
}

/**
 * 窗口组的显示方式（N2）。
 * - one：只显示 shown 这一个子终端（贴在侧边栏右边），其余收起。
 * - all：Show all，子终端都是普通窗口，平铺在侧边栏右边。
 * - collapsed：Collapse group，子终端都收起，只剩侧边栏。
 */
export type WindowGroupView = { mode: 'one'; shown: WindowId } | { mode: 'all' } | { mode: 'collapsed' };

export interface TerminalWindowData {
  /** 电脑重启后会话没了，恢复前为 null。 */
  terminalId: TerminalId | null;
  agent: AgentKind;
  cmd: string;
  args: string[];
  cwd: string;
  /** 恢复会话、Fork 用。 */
  sessionId: AgentSessionId | null;
  /** Shell 恢复时填进输入行但不运行的命令，例如 'pnpm dev'。 */
  startCommand: string | null;
  /**
   * X6：Shell 上次跑的命令（终端窗口从 TerminalInfo.foregroundCommand 记下，跑了几秒以上的才记得到），例如在 zsh 里手动敲的 'pnpm dev'。
   * 恢复上次会话时优先填它，没有再用 startCommand。不填或 null 是没记到。X6 加。
   */
  lastCommand?: string | null;
  /**
   * PL1：这个终端单独的 Auto-approve 设置（ApprovalService.setTerminalAutoApprove）。
   * true 单独开，false 框开着但它单独关；不填或 null 跟着框（FrameNode.autoApprove）。
   */
  autoApprove?: boolean | null;
  /**
   * PL2：Usage 插件在这个终端上的设置（贴在终端上边或下边的用量条）。随白板保存。
   * 不填或 null 是没开过（开的时候默认贴在上边）；on 为 false 是关着，但记得上次贴在哪边。
   */
  usage?: UsageStripSettings | null;
  /**
   * N9：这个终端选的 skill 和 MCP（SkillItemId，只存 built-in 和 library 的，repo 的跟着仓库）。
   * 不填或 null 用默认（built-in 勾、library 不勾，见 effectiveSkillSelection）。下次启动（Restart and resume）时生效。
   */
  skills?: SkillItemId[] | null;
  /**
   * PL3：Prompt queue 插件在这个终端上的队列（额度用完、到点恢复后接着发的提示词）。随白板保存。
   * 不填或 null 是没开过。
   * @deprecated 0.1.23：Prompt queue 2026-10-28 退役（并进 Auto-resume，PL6）。老白板里还有它，读得进来，界面不再读写。
   */
  queue?: PromptQueueSettings | null;
  /**
   * LA0：Hide from agents。true 时 AgentDeck 的 MCP 和 agentdeck 命令行都看不到这个终端：list_terminals 不列，
   * read_terminal、send_to_terminal 拒绝（AH11）。不填当 false。随白板保存。
   */
  hideFromAgents?: boolean;
  /**
   * SE0：这个窗口显示的 Session。窗口只引用它，名字、父子、来历都在 Session 上。
   * 老数据没有它，升级时由 store 补一条（SE1）；不填或 null 时 agents.start 兜底新建。
   */
  session?: SessionId | null;
  /**
   * PL4：这个终端单独的 Auto-resume 设置。true 单独开，false 单独关；不填或 null 跟着白板（BoardState.autoResume）；2026-10-29 起不再看框。
   */
  autoResume?: boolean | null;
  /**
   * CO4：一轮结束后、这个终端被聚焦之前为 true（标题栏写 “Idle · Unseen”，Agents 视图里粗体，不加颜色）。聚焦时清掉。
   * 随白板保存。不填当 false。
   */
  unseen?: boolean;
}

/** PL3：一条排着的提示词。 */
export interface QueuedPrompt {
  /** 界面生成的 id（排序、删除用）。 */
  id: string;
  text: string;
}

/** PL3：已经发出去的一条。 */
export interface SentPrompt {
  text: string;
  sentAt: IsoTime;
}

/** PL3：Prompt queue 的设置和进度。@deprecated 0.1.23：Prompt queue 已退役，只为读老白板留着。 */
export interface PromptQueueSettings {
  on: boolean;
  /** 还没发的，按顺序。 */
  prompts: QueuedPrompt[];
  /** 发出去的，最近的在后（最多留 50 条）。 */
  sent: SentPrompt[];
  /** 你点了 Pause：先不发。 */
  paused: boolean;
  /** 在等额度恢复、或正在接着发时不让 Mac 睡（默认 true）。 */
  keepAwake: boolean;
  /**
   * 正在接着发：碰到上限、到点发了第一条之后为 true，之后 agent 每回到空闲就发下一条，发完或碰到新的上限时变回 false。
   * 存下来是为了重开应用后能接着发。
   */
  running: boolean;
  /**
   * PL3 / IS-113（0.1.14 加）：碰到上限时记下的恢复时间和碰到的时间（都是毫秒时间戳，Date.now() 的值）。
   * 记下后就不忘：哪怕 agent 自己续跑成功、TerminalUsage.limit 被清成 null 也留着，发完第一条才清成 null。
   * 发第一条的判断看它，不看当下的 limit。不填或 null 是没在等。老数据没有它。
   */
  armed?: { resetsAt: number; at: number } | null;
}

/** PL2：用量条开没开、贴在终端哪一边。 */
export interface UsageStripSettings {
  on: boolean;
  position: 'top' | 'bottom';
}

export interface BrowserWindowData {
  /** http(s) 地址，或本地文件的绝对路径（打开时再经 BrowserService.prepare 换成可加载的地址）。 */
  url: string;
  /** frame：iframe，能跟白板一起缩放；webview：需要登录的页面用（P1）。 */
  mode: 'frame' | 'webview';
  /** 白板复用这个窗口打开同一地址时换一个新值（例如 Date.now()），网页窗口据此刷新。 */
  reloadToken?: number;
  /** 从哪个终端打开的，工具栏显示“from zsh · pnpm dev”。 */
  openedBy?: { terminalId: TerminalId; label: string } | null;
}

export interface BoardState {
  version: 1;
  viewport: Viewport;
  frames: FrameNode[];
  windows: WindowNode[];
  panel: { open: boolean; width: number };
  /** 左边栏（MVP v3 · N11 历史会话）。老数据没有它，按收着、宽 280。 */
  leftPanel?: { open: boolean; width: number };
  /** PL4：白板右键 PLUGINS 里的 Auto-resume all terminals。默认关（2026-10-28 用户定）；老数据没有它，按 false。 */
  autoResume?: boolean;
  /** CR0：集群框（在项目框里，和工作区框并列）。老数据没有它，按空数组。 */
  crews?: CrewFrameNode[];
  savedAt: IsoTime;
}

export interface BoardStore {
  /** 第一次启动返回空白板。 */
  load(): Promise<BoardState>;
  /** 整份写入。调用方负责防抖（改动后半秒）。 */
  save(state: BoardState): Promise<void>;
}

/** 在白板上开一个新窗口。终端里点 localhost 链接、框里的初始化命令都走这里。 */
export interface OpenWindowRequest<TData = unknown> {
  type: string;
  data: TData;
  /** 不填时放在发起窗口所在的工作区；null 表示散放。 */
  workspaceId?: WorkspaceId | null;
  /** 不填时放在发起窗口右边。 */
  rect?: Partial<Rect>;
  /**
   * 同类型、同 key 的窗口已经开着时聚焦它而不是新开，例如网页窗口用 URL 的 origin。
   * 复用时白板把 data 浅合并进已开窗口的 data（网页窗口看到 url 变了就跳过去，同一地址靠 reloadToken 刷新）。
   */
  reuseKey?: string;
}

/**
 * 服务让白板做的事（M1：agent 通过 MCP 开终端、工作区、网页）。终端、工作区已经由服务建好，白板只负责放上去。
 * 两者都不抢键盘焦点、不移动视口：用户可能正在别的窗口里打字。
 * - board.add-frame：把已建好的工作区放到白板的空位上；已经有框时不动。
 * - board.open-window：同窗口组件的 openWindow，但没有发起窗口，所以 request.workspaceId 总是给出（null 是散放）。
 *   highlight 为 true 时窗口闪一下，提醒用户这里多了东西。
 *   nearTerminal（N1 加）：放在这个终端的窗口右边（它在 request.workspaceId 的框里时），例如 agent 用 open_browser 开的网页
 *   放在调用者旁边。找不到那个窗口时照常放。
 * - board.open-group（N1）：一次放上一组终端（open_terminals），挂在 lead 终端的窗口旁边，组成窗口组（WindowNode.group）。
 *   lead 为 null（调用者不是白板上的终端）或白板上找不到 lead 的窗口时只是依次放进框里，不成组；lead 已经在一个组里时加进那个组。
 * - board.focus-window（N1）：把窗口拉到眼前（平移到看得见、闪一下、聚焦）。用户正在打字时只闪一下，不抢键盘焦点、不动视口。
 * - board.notify（N1）：agent 发来的一句通知。from 的窗口闪一下，并弹一条提示；用户正在打字时只闪，不弹。
 *   应用在后台时的系统通知由主进程发，不经过白板。
 */
export type BoardEvent =
  | { type: 'board.add-frame'; workspace: Workspace }
  | { type: 'board.open-window'; request: OpenWindowRequest; highlight: boolean; nearTerminal?: TerminalId | null }
  | { type: 'board.open-group'; lead: TerminalId | null; members: WindowGroupMemberRequest[]; highlight: boolean }
  | { type: 'board.focus-window'; target: { windowId: WindowId } | { terminalId: TerminalId } }
  | { type: 'board.notify'; from: TerminalId | null; message: string };

/** board.open-group 里的一个窗口。N1 加。 */
export interface WindowGroupMemberRequest {
  /** workspaceId 总是给出（null 是散放），同 board.open-window。 */
  request: OpenWindowRequest;
  /** 存进 WindowGroupRef.label。 */
  label: string | null;
}

/** 白板发给窗口的命令：⌘K 清屏、标题栏右键菜单里的项。 */
export type WindowCommand = 'clear' | 'restart' | (string & {});

export interface WindowMenuItem {
  /** 选中时作为 WindowCommand 发给窗口。 */
  id: string;
  /** 英文。 */
  label: string;
  /** 只用来显示，例如 '⌘K'。 */
  shortcut?: string;
}

/**
 * 白板交给每个窗口组件的 props。widget 只靠它和 window.agentdeck 工作，不 import 白板的内部。
 * 由 packages/ui/canvas（线 2）提供，packages/ui/widgets/*（线 1 终端、线 5 网页）使用。
 */
export interface WindowComponentProps<TData = unknown> {
  window: WindowNode<TData>;
  /** 窗口所在的工作区；散放时为 null。 */
  workspace: Workspace | null;
  /** 当前是否聚焦。聚焦时按键交给这个窗口。 */
  focused: boolean;
  /** 内容区的像素大小（不含标题栏），改大小松手后才变。 */
  contentSize: Size;
  /** true：小于 summaryBelow，白板要求画成摘要卡。 */
  summary: boolean;
  /** 窗口在视口里可见。终端据此 attach / detach。 */
  visible: boolean;
  /** 改自己的数据，白板负责保存。 */
  updateData(patch: Partial<TData>): void;
  /** 标题栏右侧的状态文字和点，例如终端的“Running · 4m”。null 清除。 */
  setStatus(status: WindowStatusBadge | null): void;
  requestFocus(): void;
  openWindow<T>(req: OpenWindowRequest<T>): void;
  close(): void;
  /** 放大或还原。titleBar 为 'none' 的窗口自己画按钮时用。 */
  toggleMaximize(): void;
  /** 订阅白板发来的命令（⌘K、标题栏右键菜单）。 */
  onCommand(listener: (command: WindowCommand) => void): Unsubscribe;
}

export interface WindowStatusBadge {
  text: string;
  /**
   * 状态灯的颜色（MVP v2 · V2）：'running' 绿，'attention' 黄（只用于需要你处理），'error' 红，
   * 'muted' 灰，'default' 墨色。'running' 是 0.1.6 加的。
   */
  tone: 'default' | 'muted' | 'running' | 'attention' | 'error';
  dot: 'filled' | 'hollow' | 'none';
  /** 悬停时的说明，例如 Waiting 时写 “Needs approval” 还是 “Needs reply”。0.1.6 加。 */
  detail?: string;
  /**
   * 状态文字后面的淡色小标签，例如终端 cd 到工作区外面时的 “outside workspace”（IS-57，MVP v3 · N7）。
   * 只是提示，不影响状态灯和“在等你”。text 为空不画。白板判断 badge 有没有变时要连 tag 一起比。
   */
  tag?: WindowStatusTag;
}

/** WindowStatusBadge.tag。 */
export interface WindowStatusTag {
  /** 标签文字，英文小写，例如 “outside workspace”。 */
  text: string;
  /** 悬停说明，例如实际目录和工作区目录。 */
  detail?: string;
}

/**
 * 窗口注册表的条目。加一种窗口 = 加一个文件夹 + 调一次 registerWindow。
 * TComponent 由 ui 层定为 React 组件类型，contracts 不依赖 React。
 */
export interface WindowTypeDefinition<TData, TComponent = unknown> {
  type: string;
  /** 菜单里显示的名字，英文。 */
  label: string;
  defaultSize: Size;
  minSize: Size;
  /** 小于这个尺寸时显示摘要卡（终端是 320×200）。没有就不变摘要卡。 */
  summaryBelow?: Size;
  component: TComponent;
  /** 新建时的初始数据。 */
  create(init: Partial<TData>): TData;

  // 以下都可选。白板只读这些字段，不按 type 写特例。
  /** 创建后不能换框（终端：进程的目录改不了）。拖进别的框时弹回并提示。 */
  pinnedToWorkspace?: boolean;
  /** 标题栏上的名字（等宽字），用户没有 Rename 时用。例如终端返回 agent 名或命令名。 */
  title?(data: TData): string;
  /** 关闭前要确认时返回对话框文案（英文），不用确认返回 null。 */
  closeConfirm?(data: TData): { title: string; body: string; confirm: string } | null;
  /** 确认关闭后要做的事，例如结束终端进程。 */
  onClose?(data: TData): Promise<void>;
  /** 加到标题栏右键菜单里的项，选中时走 WindowComponentProps.onCommand。 */
  menu?: WindowMenuItem[];
  /** 'board'（默认）：白板画标题栏；'none'：窗口自己画一整行，元素上加 data-window-drag 作为拖动区域。 */
  titleBar?: 'board' | 'none';
  /** 由内容区像素大小算行列数，白板新开终端时传给 agents.start。没有就由白板粗估、attach 后由窗口校正。 */
  termSize?(contentSize: Size): TermSize;
  /**
   * X6：窗口背后的进程没了（Stop all and quit、电脑重启、tmux 服务被结束）之后怎么恢复。
   * 白板启动时（和收到 terminal.host-lost 后）对每个窗口问 describe，有要恢复的就弹 “Restore your last session?”，
   * 选 Restore all 时逐个调 restore 并把返回的改动合进 data。窗口位置、id 不变。现在只有终端窗口有。X6 加。
   */
  restore?: WindowRestoreSupport<TData>;
}

/** WindowTypeDefinition.restore。X6 加。 */
export interface WindowRestoreSupport<TData> {
  /** 要恢复时说明恢复后是什么样；进程还在（或这个窗口没有进程）时返回 null。live 是 terminals.list() 里还在的终端。 */
  describe(data: TData, live: ReadonlySet<TerminalId>): WindowRestoreItem | null;
  /** 重新启动，返回要合进 data 的改动（例如新的 terminalId）。失败时抛 AgentDeckError，message 给人看。 */
  restore(data: TData, ctx: WindowRestoreContext): Promise<WindowRestoreResult<TData>>;
}

export interface WindowRestoreItem {
  /** 恢复提示里分开数：agent（claude、codex……）和 shell（Shell、自定义命令）。 */
  kind: 'agent' | 'shell';
  /** 名字，例如 'claude'、'zsh'。英文原样。 */
  label: string;
  /** 恢复后会怎样，一句英文，例如 'Resumes the conversation'、'Opens zsh with “pnpm dev” typed in, not run'。 */
  detail: string;
  /** true：接不回原来的东西，会重新开始（例如 agent 没记下会话 id）。 */
  fresh: boolean;
}

export interface WindowRestoreContext {
  workspaceId: WorkspaceId | null;
  /** 窗口内容区的像素大小，用来算终端的行列数。 */
  contentSize: Size;
}

export interface WindowRestoreResult<TData> {
  patch: Partial<TData>;
  /** 实际是不是重新开始的（例如记下的会话接不回，退回了新对话）。 */
  fresh: boolean;
}
