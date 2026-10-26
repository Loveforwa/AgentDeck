// BoardController：白板的全部行为。React 组件只负责画和把手势交给它；它只通过 window.agentdeck（AgentDeckApi）调服务。
// 不依赖 React，测试里直接拿 createFakeApi() 跑。

import type { AgentDeckApi, AgentDeckErrorData, BackgroundAgent, FrameArrange, FrameLayout, AgentKind, BoardState, LaunchMode, CreateWorkspaceRequest, ErrorCode, FrameNode, OpenWindowRequest, ProjectId, ProjectPatch, Rect, Settings, Size, TerminalId, TerminalWindowData, Unsubscribe, Viewport, WindowCommand, WindowGroupId, WindowGroupMemberRequest, WindowId, WindowNode, WindowStatusBadge, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { TITLE_BAR_HEIGHT, resizeRect, type ResizeEdge } from '@agentdeck/ui-window-shell';
import { isSummarySize, windowRegistry, type WindowDefinition, type WindowRegistry } from './registry.ts';
import { ApprovalsModel } from './approvals/model.ts';
import { usageOutset } from './plugins/usage-model.ts';
import { PLUGIN_MARK_HEIGHT } from './plugins/types.ts';
import { hintOf, transcriptRect } from './model/background.ts';
import { LAYOUT_LABEL, arrangeBlocks, type ArrangeBlock } from './model/arrange.ts';
import { startableAgents } from './model/agents.ts';
import { nextWaiting, prevWaiting, summarize, statusOf, type AttentionSummary } from './model/attention.ts';
import { createAutosave, type Autosave } from './model/autosave.ts';
import { GAP, clampFrameMove, findFreeSpot, inflate, pushFrames, separateFrames, tooClose } from './model/avoid.ts';
import { decideDrop, dropTargetAt } from './model/drop.ts';
import { forkCheck, type ForkCheck } from './model/fork.ts';
import {
  FRAME_HEADER,
  FRAME_MIN,
  FRAME_PAD,
  bounds,
  center,
  containsPoint,
  fitViewport,
  frameAround,
  growFrame,
  innerArea,
  intersects,
  resizeFrame,
  sameRect,
  toFlow,
  union,
  visibleRect,
  zoomAroundCenter,
  type Point,
} from './model/geometry.ts';
import {
  atSlot,
  dissolveGroups,
  dockSlot,
  dockable,
  groupOf,
  groupView,
  hiddenMembers,
  listGroups,
  setGroupView,
  sidebarRect,
  syncGroups,
  type WindowGroup,
} from './model/groups.ts';
import { BoardHistory, applyStep, diffLayout, type BoardLayout, type Direction, type HistoryStep } from './model/history.ts';
import { adjacentWindow, windowOrder } from './model/navigation.ts';
import { restoreResultMessage, type RestoreOutcome, type RestoreSessionItem } from './model/restore.ts';
import { boxFrom, boxSelection, byWorkspace, toggleSelection, translate, windowsInBox } from './model/selection.ts';
import type { ShortcutId } from './model/shortcuts.ts';
import { NEAR_FRAME_PX, SNAP_PX, snapMove, snapResize, type Guide } from './model/snap.ts';
import {
  BROWSER_TYPE,
  TERMINAL_TYPE,
  agentNoun,
  defaultName,
  estimateTermSize,
  isTerminal,
  terminalIdOf,
  workspaceLabel,
} from './model/windows.ts';
import {
  createBoardStore,
  savedPart,
  savedPartChanged,
  type BoardStore,
  type BoardStoreState,
  type DialogState,
  type MenuState,
  type PendingFrame,
  type SettingsSection,
} from './store.ts';

/** 白板组件注册进来，让控制器能做带动画的平移缩放。没有时（测试）直接改 store。 */
export interface ViewportApi {
  setViewport(vp: Viewport, opts?: { duration?: number }): void;
  /** 白板区域左上角的屏幕坐标（clientX / clientY 的坐标系）。 */
  origin(): Point;
}

export interface BoardControllerOptions {
  api: AgentDeckApi;
  registry?: WindowRegistry;
  /** 散放的终端在哪个目录运行。contracts 里没有取主目录的方法，默认交给服务展开 '~'（见 CONTRACT_NOTES.md）。 */
  homeDir?: string;
  /** 保存防抖，默认 500ms。 */
  autosaveMs?: number;
  /** 一句话的提示（Toast）。 */
  notify?(message: string): void;
  /** 换掉默认的 Add project… 流程（选文件夹 → probe → add）。返回新加的项目，取消返回 null。 */
  addProject?(): Promise<ProjectId | null>;
}

/** 新窗口默认大小：终端 560×360（需求「5 · 终端窗口」）。没有注册时用这个。 */
const FALLBACK_SIZE: Size = { w: 560, h: 360 };
/**
 * 低于这个缩放比例时，有 summaryBelow 的窗口都画成摘要卡（需求「3 · 白板」原定 75%）。
 * 2026-10-24 验收时 ⌘− 缩一点点（73%）终端就不显示内容，太早了，改成 50%（IS-41）；
 * 终端窗口在“缩小导致的摘要”里显示整屏文字快照，不只是 3 行。
 */
export const SUMMARY_ZOOM = 0.5;
/** 窗口放大时离视口边的距离。 */
const MAXIMIZE_MARGIN = 16;
const STOPPED = new Set(['exited', 'error']);

/** 挪框之前各框、各框里窗口的位置（V3：框变大时把挤到的框挪开，拖动中每次都从这里重新算）。 */
interface LayoutBase {
  frames: Map<WorkspaceId, Rect>;
  windows: Map<WindowId, { ws: WorkspaceId; rect: Rect; restore: Rect | null }>;
}

type DragSession =
  | { kind: 'move-window'; id: WindowId; start: Rect; frameStart: Rect | null }
  /**
   * X10：拖选中的一个，选中的都跟着动（同一个位移）。不换框（不弹 W5），每个框按自己那一批长；吸附看所有选中窗口的外接矩形。
   * frameLast：拖动中最后一次给各个框设的大小（松手时看它有没有被别的框挤开过）。
   */
  | {
      kind: 'move-group';
      id: WindowId;
      ids: WindowId[];
      starts: Map<WindowId, Rect>;
      bbox: Rect;
      frameStarts: Map<WorkspaceId, Rect>;
      frameLast: Map<WorkspaceId, Rect>;
    }
  | { kind: 'resize-window'; id: WindowId; edge: ResizeEdge; start: Rect; frameStart: Rect | null; base: LayoutBase }
  | { kind: 'move-frame'; ws: WorkspaceId; start: Rect; windows: Map<WindowId, Rect>; last: Rect }
  | { kind: 'resize-frame'; ws: WorkspaceId; edge: ResizeEdge; start: Rect; content: Rect | null; base: LayoutBase };

/** 拖动和改大小的选项。snap：吸附到对齐线（界面上按住 ⌘ 时为 false）；不给时不吸，测试和程序调用照原样移动。 */
export interface DragOptions {
  snap?: boolean;
}

let idSeq = 0;
function newWindowId(): WindowId {
  idSeq += 1;
  return `win-${Date.now().toString(36)}-${idSeq}` as WindowId;
}

function newGroupId(): WindowGroupId {
  idSeq += 1;
  return `grp-${Date.now().toString(36)}-${idSeq}` as WindowGroupId;
}

/** 最后一次按键后多久内算“正在打字”（毫秒）。 */
export const TYPING_MS = 2000;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export class BoardController {
  readonly store: BoardStore;
  readonly registry: WindowRegistry;
  viewportApi: ViewportApi | null = null;
  readonly api: AgentDeckApi;
  private readonly opts: BoardControllerOptions;
  private readonly autosave: Autosave<BoardState>;
  private readonly unsubs: Unsubscribe[] = [];
  private drag: DragSession | null = null;
  /** 用户最近一次按键的时间（N1：用户正在打字时，服务让白板做的事只闪一下，不抢焦点、不弹提示）。 */
  private lastKeyAt = Number.NEGATIVE_INFINITY;
  /** WindowComponentProps.onCommand 的订阅，按窗口记。 */
  private readonly commandListeners = new Map<WindowId, Set<(command: WindowCommand) => void>>();
  private lastBadgeCount = -1;
  private started = false;
  private pendingSeq = 0;
  /** 批准（PL1 Auto-approve、Approval history、X3 Approve all），见 approvals/model.ts。 */
  readonly approvals: ApprovalsModel;
  /** X10：撤销 / 重做（只在这次运行里）。 */
  readonly history = new BoardHistory();
  /** 正在拖动（移动、改大小）时，按下那一刻的白板；松手时和现在比，算成一步。 */
  private dragBase: BoardLayout | null = null;
  /** record() 嵌套时只在最外层记一步。 */
  private recordBase: BoardLayout | null = null;
  private recordDepth = 0;
  /** 框选开始时已经选中的（⌘ + 框选加在上面）。 */
  private boxBase: { start: Point; base: WindowId[]; additive: boolean } | null = null;

  constructor(opts: BoardControllerOptions) {
    this.opts = opts;
    this.api = opts.api;
    this.registry = opts.registry ?? windowRegistry;
    this.store = createBoardStore();
    this.approvals = new ApprovalsModel(this, (message) => this.notify(message));
    this.autosave = createAutosave<BoardState>({
      save: (state) => this.api.board.save(state),
      delayMs: opts.autosaveMs ?? 500,
      onError: (e) => this.notify(`Couldn’t save the board: ${errorMessage(e)}`),
    });
  }

  get state(): BoardStoreState {
    return this.store.getState();
  }

  private set(patch: Partial<BoardStoreState> | ((s: BoardStoreState) => Partial<BoardStoreState>)): void {
    this.store.setState((s) => {
      const p = typeof patch === 'function' ? patch(s) : patch;
      // N2：窗口组的停靠（收起的子终端、贴在侧边栏右边的那个）跟着 lead 走
      return p.windows && p.windows !== s.windows ? { ...p, windows: syncGroups(s.windows, p.windows, (w) => this.footprint(w)) } : p;
    });
  }

  private notifyHandler: ((message: string) => void) | null = null;

  /** 换掉提示的显示方式（Workbench 接到自己的 Toast 上）。 */
  setNotify(handler: ((message: string) => void) | null): void {
    this.notifyHandler = handler;
  }

  private notify(message: string): void {
    (this.notifyHandler ?? this.opts.notify)?.(message);
  }

  // ---- 启动和事件 ----

  /** 读白板、项目、工作区、agent、状态，订阅事件。返回的 Promise 在白板恢复后完成。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { api } = this;
    this.unsubs.push(
      api.on('status.changed', (e) => this.set((s) => ({ statuses: { ...s.statuses, [e.snapshot.terminalId]: e.snapshot } }))),
      api.on('workspace.changed', (e) => this.set((s) => ({ workspaces: { ...s.workspaces, [e.workspace.id]: e.workspace } }))),
      api.on('workspace.removed', (e) => this.dropWorkspace(e.id)),
      api.on('workspace.progress', (e) =>
        this.set((s) => ({
          pending: s.pending.map((p) =>
            p.projectId === e.projectId && (e.branch === undefined || p.request.branch?.name === e.branch) && !p.error
              ? { ...p, message: e.message }
              : p,
          ),
        })),
      ),
      api.on('project.changed', () => void this.refreshProjects()),
      api.on('project.removed', () => void this.refreshProjects()),
      api.on('app.focus-terminal', (e) => {
        const w = this.state.windows.find((n) => terminalIdOf(n) === e.terminalId);
        if (w) this.jumpToWindow(w.id);
      }),
      api.on('board.add-frame', (e) => this.addFrameFromService(e.workspace)),
      api.on('board.open-window', (e) => void this.openWindowFromService(e.request, e.highlight, e.nearTerminal ?? null)),
      api.on('board.open-group', (e) => void this.openGroupFromService(e.lead, e.members, e.highlight)),
      api.on('board.focus-window', (e) => this.focusFromService(e.target)),
      api.on('board.notify', (e) => this.notifyFromService(e.from, e.message)),
      // N10：agent 自带的后台子 agent
      api.on('subagents.changed', (e) => this.setBackgroundAgents(e.agents.terminalId, e.agents.agents)),
      // X6：tmux 服务没了（被结束、崩了）：窗口都显示 Session ended，问一次要不要全部恢复
      api.on('terminal.host-lost', () => void this.checkRestore()),
    );
    // 用户在哪儿打字（终端的 xterm、对话框的输入框……）都会经过 window 的 keydown（捕获阶段）。网页窗口的 iframe 里的按键收不到。
    if (typeof window !== 'undefined') {
      const onKey = () => this.noteKeyboardInput();
      window.addEventListener('keydown', onKey, true);
      this.unsubs.push(() => window.removeEventListener('keydown', onKey, true));
    }
    void this.approvals.start();
    // 标记（书签、后台 agent 的小提示）、Usage 条出现了：框长到装得下（N10，只变大）。两个 store 都可能让它变，合并到下一个微任务里查一次
    let marksQueued = false;
    const checkMarks = () => {
      if (marksQueued) return;
      marksQueued = true;
      queueMicrotask(() => {
        marksQueued = false;
        if (this.started) this.keepMarksInFrames();
      });
    };
    this.unsubs.push(this.store.subscribe(checkMarks), this.approvals.store.subscribe(checkMarks));
    // N12：开着 Auto-arrange 的框里多了、少了窗口：下一个微任务里重排
    this.unsubs.push(this.store.subscribe(() => this.noteFrameMembers()));
    // 存档：保存的那部分一变就排进防抖
    this.unsubs.push(
      this.store.subscribe((s, prev) => {
        if (s.loaded && prev.loaded && savedPartChanged(s, prev)) this.autosave.schedule(this.snapshotBoard());
        this.updateBadge(s);
      }),
    );

    const [board, workspaces, projects, agents, statuses] = await Promise.all([
      api.board.load(),
      api.workspaces.list().catch(() => []),
      api.projects.list().catch(() => []),
      api.agents.list().catch(() => []),
      api.status.snapshot().catch(() => []),
    ]);
    this.set((s) => ({
      viewport: board.viewport,
      frames: board.frames,
      windows: board.windows,
      panel: board.panel,
      workspaces: Object.fromEntries(workspaces.map((w) => [w.id, w])),
      projects,
      agents,
      // 启动期间已经收到的 status.changed 比快照新，保留
      statuses: { ...Object.fromEntries(statuses.map((st) => [st.terminalId, st])), ...s.statuses },
      loaded: true,
    }));
    this.separateOverlappingFrames();
    // N10：界面重开时主进程里已经有的后台 agent（之后靠 subagents.changed）。
    // 开发时界面热更新了、主进程还是旧的（没有 subagents）也不能让启动失败
    void Promise.resolve()
      .then(() => api.subagents.list())
      .then((all) => {
        for (const t of all) if (!this.state.backgroundAgents[t.terminalId]) this.setBackgroundAgents(t.terminalId, t.agents);
      })
      .catch(() => undefined);
    // X6：Stop all and quit、电脑重启之后，保存的窗口还在、进程没了。不等它，白板先画出来
    void this.checkRestore();
  }

  // ---- X6：恢复上次会话 ----

  /** 进程没了、要恢复的窗口（各窗口类型的 restore.describe）。live 是 terminals.list() 里还在的终端。 */
  restoreCandidates(live: ReadonlySet<TerminalId>): RestoreSessionItem[] {
    const out: RestoreSessionItem[] = [];
    for (const w of this.state.windows) {
      const item = this.definitionOf(w)?.restore?.describe(w.data, live);
      if (item) out.push({ ...item, windowId: w.id, workspaceId: w.workspaceId });
    }
    return out;
  }

  /**
   * 有窗口要恢复时弹 “Restore your last session?”。tmux 会话都在（普通的 ⌘Q 再打开）时什么都不做：窗口自己接上。
   * 读不到终端列表（tmux 不可用）时也不弹，窗口自己会显示原因。用户正开着别的对话框时不打断。
   */
  async checkRestore(): Promise<void> {
    let ids: TerminalId[];
    try {
      ids = (await this.api.terminals.list()).map((t) => t.id);
    } catch {
      return;
    }
    if (!this.started) return;
    const items = this.restoreCandidates(new Set(ids));
    const open = this.state.dialog;
    if (items.length === 0) {
      if (open?.kind === 'restore-session') this.closeDialog();
      return;
    }
    if (open && open.kind !== 'restore-session') return;
    this.openDialog({ kind: 'restore-session', items });
  }

  /** Restore all：逐个窗口按它的类型恢复（agent 接回对话、Shell 填好命令），位置和窗口 id 不变。完成后提示一句。 */
  async restoreAll(): Promise<RestoreOutcome[]> {
    const dialog = this.state.dialog;
    const items = dialog?.kind === 'restore-session' ? dialog.items : [];
    if (dialog?.kind === 'restore-session') this.closeDialog();
    const outcomes = await Promise.all(items.map((item) => this.restoreOne(item)));
    const done = outcomes.filter((o): o is RestoreOutcome => o !== null);
    if (done.length) this.notify(restoreResultMessage(done));
    return done;
  }

  private async restoreOne(item: RestoreSessionItem): Promise<RestoreOutcome | null> {
    const w = this.windowById(item.windowId);
    const support = w ? this.definitionOf(w)?.restore : undefined;
    if (!w || !support) return null;
    try {
      const res = await support.restore(w.data, { workspaceId: w.workspaceId, contentSize: this.contentSizeOf(w.rect) });
      if (this.windowById(w.id)) this.updateData(w.id, res.patch as object);
      return { item, fresh: res.fresh, error: null };
    } catch (e) {
      return { item, fresh: false, error: errorMessage(e) };
    }
  }

  /** 老布局里互相盖住的框（IS-53、IS-54）启动时分开，框里的窗口跟着走；没有重叠时什么都不改。 */
  private separateOverlappingFrames(): void {
    const s = this.state;
    const moved = separateFrames(new Map(s.frames.map((f) => [f.workspaceId, f.rect])), GAP);
    if (moved.size === 0) return;
    const shift = new Map<WorkspaceId, { dx: number; dy: number }>();
    for (const f of s.frames) {
      const r = moved.get(f.workspaceId);
      if (r) shift.set(f.workspaceId, { dx: r.x - f.rect.x, dy: r.y - f.rect.y });
    }
    this.set({
      frames: s.frames.map((f) => (moved.has(f.workspaceId) ? { ...f, rect: moved.get(f.workspaceId)! } : f)),
      windows: s.windows.map((w) => {
        const d = w.workspaceId ? shift.get(w.workspaceId) : undefined;
        if (!d) return w;
        const mv = (r: Rect) => ({ ...r, x: r.x + d.dx, y: r.y + d.dy });
        return { ...w, rect: mv(w.rect), restoreRect: w.restoreRect ? mv(w.restoreRect) : null };
      }),
    });
  }

  /** 取消订阅、写入没保存的改动。之后可以再 start()（React StrictMode 会这样）。 */
  dispose(): void {
    this.started = false;
    for (const u of this.unsubs.splice(0)) u();
    this.approvals.dispose();
    void this.autosave.flush();
    this.autosave.dispose();
  }

  /** 立刻保存还没保存的改动（关窗口前）。 */
  flush(): Promise<void> {
    return this.autosave.flush();
  }

  snapshotBoard(): BoardState {
    return { version: 1, ...savedPart(this.state), savedAt: new Date().toISOString() };
  }

  private async refreshProjects(): Promise<void> {
    const projects = await this.api.projects.list().catch(() => null);
    if (projects) this.set({ projects });
  }

  private updateBadge(s: BoardStoreState): void {
    const n = this.attentionOf(s).waiting.length;
    if (n === this.lastBadgeCount || !s.loaded) return;
    this.lastBadgeCount = n;
    this.api.app.setBadge(n);
  }

  // ---- 查询 ----

  attention(): AttentionSummary {
    return this.attentionOf(this.state);
  }

  private attentionOf(s: BoardStoreState): AttentionSummary {
    return summarize({ windows: s.windows, statuses: s.statuses, badges: s.badges });
  }

  windowById(id: WindowId): WindowNode | undefined {
    return this.state.windows.find((w) => w.id === id);
  }

  frameOf(ws: WorkspaceId | null): FrameNode | undefined {
    return ws ? this.state.frames.find((f) => f.workspaceId === ws) : undefined;
  }

  definitionOf(node: Pick<WindowNode, 'type'>): WindowDefinition | undefined {
    return this.registry.get(node.type);
  }

  /** 右侧面板跟随的工作区：选中的框，否则聚焦窗口所在的工作区。 */
  activeWorkspaceId(s: BoardStoreState = this.state): WorkspaceId | null {
    if (s.selectedFrame) return s.selectedFrame;
    const w = s.focusedId ? s.windows.find((n) => n.id === s.focusedId) : undefined;
    return w?.workspaceId ?? null;
  }

  workspaceTitle(ws: WorkspaceId | null): string {
    const w = ws ? this.state.workspaces[ws] : undefined;
    const project = w ? this.state.projects.find((p) => p.id === w.projectId) : undefined;
    return workspaceLabel(w, project?.name);
  }

  /** 内容区的像素大小（窗口 rect 减去边框和标题栏）。 */
  contentSizeOf(rect: Size): Size {
    return { w: Math.max(0, rect.w - 2), h: Math.max(0, rect.h - TITLE_BAR_HEIGHT - 2) };
  }

  isSummary(node: WindowNode, rect: Size = node.rect, zoom = this.state.viewport.zoom): boolean {
    const def = this.definitionOf(node);
    if (!def?.summaryBelow) return false;
    return isSummarySize(def, rect) || zoom < SUMMARY_ZOOM;
  }

  /** 放大中：有 restoreRect 且不是被拉小成摘要卡（拉小时 restoreRect 记的是拉小前的大小）。 */
  isMaximized(node: WindowNode): boolean {
    if (!node.restoreRect) return false;
    const def = this.definitionOf(node);
    return !(def && isSummarySize(def, node.rect));
  }

  isVisible(rect: Rect, s: BoardStoreState = this.state): boolean {
    return intersects(rect, visibleRect(s.viewport, s.pane));
  }

  private maxWindowZ(): number {
    return this.state.windows.reduce((m, w) => Math.max(m, w.z), 0);
  }

  private maxFrameZ(): number {
    return this.state.frames.reduce((m, f) => Math.max(m, f.z), 0);
  }

  private windowsIn(ws: WorkspaceId): WindowNode[] {
    return this.state.windows.filter((w) => w.workspaceId === ws);
  }

  /** 框里的东西占的范围（改框大小时不能小于它）：窗口连同标记、Usage 条、侧边栏、后台 agent 面板。 */
  private contentBounds(ws: WorkspaceId): Rect | null {
    const hidden = hiddenMembers(this.state.windows);
    return bounds(this.windowsIn(ws).map((w) => (hidden.has(w.id) || this.isMaximized(w) ? w.rect : this.withGroup(w.id, w.rect))));
  }

  // ---- 修改窗口和框 ----

  private patchWindow(id: WindowId, patch: Partial<WindowNode> | ((w: WindowNode) => Partial<WindowNode>)): void {
    this.set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, ...(typeof patch === 'function' ? patch(w) : patch) } : w)),
    }));
  }

  private patchFrame(ws: WorkspaceId, patch: Partial<FrameNode>): void {
    this.set((s) => ({ frames: s.frames.map((f) => (f.workspaceId === ws ? { ...f, ...patch } : f)) }));
  }

  /** 让框装下这个窗口（只变大）；挤到的框挪开（V3）。 */
  private fitFrameTo(ws: WorkspaceId | null, rect: Rect): void {
    const f = this.frameOf(ws);
    if (!f || !ws) return;
    const grown = growFrame(f.rect, rect);
    if (!sameRect(grown, f.rect)) this.applyFrameChange(this.layoutBase(), ws, f.rect, grown);
  }

  // ---- 不重叠和对齐线（V3） ----

  /** 窗口占的地方：放大中的窗口按还原后的位置算（放大的窗口可以盖住同一个框里的别的窗口）。 */
  private footprint(w: WindowNode): Rect {
    return this.isMaximized(w) && w.restoreRect ? w.restoreRect : w.rect;
  }

  /**
   * 避让时窗口占的地方：footprint 再加上挂在外框外面的东西——Usage 用量条（PL2，上边或下边）、底边的标记
   * （Auto-approve 书签、N10 后台 agent 的小提示）。对齐线仍然只看窗口本身。
   */
  private obstacleRect(w: WindowNode, rect: Rect = this.footprint(w)): Rect {
    const out = this.markOutset(w);
    return out.top || out.bottom ? { ...rect, y: rect.y - out.top, h: rect.h + out.top + out.bottom } : rect;
  }

  /**
   * 挂在窗口外框外面的东西占多高：底边的标记（Auto-approve 书签、后台 agent 的小提示）一行，
   * Usage 条在上边或下边（下边时排在标记下面，见 canvas.css）。框要装下它们（N10，2026-10-26 用户定）。
   */
  markOutset(w: WindowNode): { top: number; bottom: number } {
    const u = usageOutset(w);
    const tid = terminalIdOf(w);
    const marks = this.approvals.windowOn(w) || (tid !== null && hintOf(this.state.backgroundAgents[tid] ?? []) !== null);
    return { top: u.top, bottom: u.bottom + (marks ? PLUGIN_MARK_HEIGHT : 0) };
  }

  /** 对齐线看的窗口：同一个框里别的窗口；散放的窗口看视口里别的散放窗口。 */
  private snapTargets(id: WindowId, ws: WorkspaceId | null): Rect[] {
    const s = this.state;
    const skip = this.groupSkip(id);
    return s.windows
      .filter((w) => w.id !== id && w.workspaceId === ws && !skip.has(w.id) && (ws !== null || this.isVisible(w.rect, s)))
      .map((w) => this.footprint(w));
  }

  /**
   * 拖窗口时也对齐的框（IS-65）：在视口里、离 anchor（窗口所在的框连同窗口；散放的窗口就是它自己）不到 NEAR_FRAME_PX
   * 屏幕像素的框，也就是旁边的框，看它们的外边和中线。skip：窗口自己的框（拖动中跟着窗口长）和指针所在的框（看它的内边）。
   */
  private nearbyFrames(anchor: Rect, skip: readonly (WorkspaceId | null)[]): Rect[] {
    const s = this.state;
    const near = inflate(anchor, NEAR_FRAME_PX / s.viewport.zoom);
    return s.frames.filter((f) => !skip.includes(f.workspaceId) && this.isVisible(f.rect, s) && intersects(near, f.rect)).map((f) => f.rect);
  }

  /** 吸附距离：屏幕上 SNAP_PX，换成白板坐标。 */
  private snapThreshold(): number {
    return SNAP_PX / this.state.viewport.zoom;
  }

  /**
   * 松手或新放上来时：盖住同一个框里（散放的：别的散放窗口）别的窗口，就挪到最近的空位，优先在框里；放不下就放到框外，
   * 由调用方让框跟着长。不推别的窗口。frameRect：框拖动前的位置。
   */
  private freeSpotFor(id: WindowId | null, ws: WorkspaceId | null, rect: Rect, frameRect: Rect | null): Rect {
    // N2：lead 连同侧边栏和停靠的子终端一起找空位；收起的子终端不挡，别的组的侧边栏挡
    const self = id ? this.windowById(id) : undefined;
    const ext = id ? union(this.withGroup(id, rect), self ? this.obstacleRect(self, rect) : rect) : rect;
    const skip = this.groupSkip(id);
    const obstacles = [
      ...this.state.windows.filter((w) => w.id !== id && w.workspaceId === ws && !skip.has(w.id)).map((w) => this.obstacleRect(w)),
      ...this.sidebarObstacles(ws, id),
    ];
    const spot = findFreeSpot(ext, obstacles, { gap: GAP, area: frameRect ? innerArea(growFrame(frameRect, ext)) : null });
    return { ...rect, x: rect.x + spot.x - ext.x, y: rect.y + spot.y - ext.y };
  }

  private layoutBase(): LayoutBase {
    const s = this.state;
    const windows: LayoutBase['windows'] = new Map();
    for (const w of s.windows) if (w.workspaceId) windows.set(w.id, { ws: w.workspaceId, rect: w.rect, restore: w.restoreRect });
    return { frames: new Map(s.frames.map((f) => [f.workspaceId, f.rect])), windows };
  }

  /**
   * ws 的框从 before 变成 after：挤到的框连同里面的窗口挪开（框之间至少 GAP）。别的框都按 base 的位置算，
   * 拖动中每次从 base 重新算，所以框又变小时被挪开的框会回到原处。
   */
  private applyFrameChange(base: LayoutBase, ws: WorkspaceId, before: Rect | null, after: Rect): void {
    const pushed = pushFrames(base.frames, { id: ws, before, after }, GAP);
    const s = this.state;
    let framesChanged = false;
    const frames = s.frames.map((f) => {
      const b = base.frames.get(f.workspaceId);
      const r = f.workspaceId === ws ? after : b ? (pushed.get(f.workspaceId) ?? b) : f.rect;
      if (sameRect(r, f.rect)) return f;
      framesChanged = true;
      return { ...f, rect: r };
    });
    let windowsChanged = false;
    const windows = s.windows.map((w) => {
      const b = base.windows.get(w.id);
      if (!b || b.ws === ws) return w;
      const from = base.frames.get(b.ws);
      const to = pushed.get(b.ws) ?? from;
      if (!from || !to) return w;
      const mv = (r: Rect) => ({ ...r, x: r.x + to.x - from.x, y: r.y + to.y - from.y });
      const rect = mv(b.rect);
      const restoreRect = b.restore ? mv(b.restore) : null;
      if (sameRect(rect, w.rect) && sameRect(restoreRect, w.restoreRect)) return w;
      windowsChanged = true;
      return { ...w, rect, restoreRect };
    });
    if (framesChanged || windowsChanged) this.set({ ...(framesChanged ? { frames } : {}), ...(windowsChanged ? { windows } : {}) });
  }

  focusWindow(id: WindowId | null): void {
    const s = this.state;
    if (id === null) {
      if (s.focusedId !== null || s.selectedFrame !== null) this.set({ focusedId: null, selectedFrame: null });
      return;
    }
    const w = this.windowById(id);
    if (!w) return;
    const top = this.maxWindowZ();
    this.set((st) => ({
      focusedId: id,
      selectedFrame: null,
      windows: w.z === top && st.windows.filter((n) => n.z === top).length === 1 ? st.windows : st.windows.map((n) => (n.id === id ? { ...n, z: top + 1 } : n)),
    }));
  }

  /** 单击框的标题栏：选中框（提到最上层），不改变聚焦的窗口以外的东西。 */
  selectFrame(ws: WorkspaceId | null): void {
    if (ws === null) return this.set({ selectedFrame: null });
    const f = this.frameOf(ws);
    if (!f) return;
    const top = this.maxFrameZ();
    this.set((s) => ({
      selectedFrame: ws,
      focusedId: null,
      selection: s.selection.length > 0 ? [] : s.selection,
      frames: f.z === top ? s.frames : s.frames.map((n) => (n.workspaceId === ws ? { ...n, z: top + 1 } : n)),
    }));
  }

  updateData(id: WindowId, patch: object): void {
    this.patchWindow(id, (w) => ({ data: { ...(w.data as object), ...patch } }));
  }

  setBadge(id: WindowId, badge: WindowStatusBadge | null): void {
    this.set((s) => {
      const cur = s.badges[id];
      if (!badge) {
        if (!cur) return {};
        const { [id]: _, ...rest } = s.badges;
        return { badges: rest };
      }
      if (
        cur && cur.text === badge.text && cur.tone === badge.tone && cur.dot === badge.dot && cur.detail === badge.detail
        && cur.tag?.text === badge.tag?.text && cur.tag?.detail === badge.tag?.detail
      ) return {};
      return { badges: { ...s.badges, [id]: badge } };
    });
  }

  renameWindow(id: WindowId, title: string): void {
    this.record('Rename window', () => this.patchWindow(id, { title: title.trim() || null }));
  }

  async renameWorkspace(ws: WorkspaceId, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    const before = this.state.workspaces[ws]?.name;
    try {
      const updated = await this.api.workspaces.rename(ws, trimmed);
      this.set((s) => ({ workspaces: { ...s.workspaces, [ws]: updated } }));
      if (before !== undefined && before !== updated.name) {
        this.history.push({ label: 'Rename workspace', windows: [], frames: [], name: { ws, before, after: updated.name } });
      }
    } catch (e) {
      this.notify(errorMessage(e));
    }
  }

  // ---- 拖动：窗口 ----

  moveWindowStart(id: WindowId): void {
    const w = this.windowById(id);
    if (!w) return;
    this.dragBase = this.layout();
    // X10：拖的是选中的窗口之一，选中的都一起动
    const group = this.movableSelection(id);
    if (group.length > 1) {
      const starts = new Map(group.map((g) => [g.id, g.rect]));
      const frameStarts = new Map<WorkspaceId, Rect>();
      for (const g of group) {
        const f = this.frameOf(g.workspaceId);
        if (f) frameStarts.set(f.workspaceId, f.rect);
      }
      this.drag = {
        kind: 'move-group',
        id,
        ids: group.map((g) => g.id),
        starts,
        bbox: bounds([...starts.values()])!,
        frameStarts,
        frameLast: new Map(frameStarts),
      };
      this.set({ lifted: id });
      return;
    }
    this.drag = { kind: 'move-window', id, start: w.rect, frameStart: this.frameOf(w.workspaceId)?.rect ?? null };
    this.set({ lifted: id });
  }

  /**
   * dx、dy：白板坐标的总位移；pointer：指针的白板坐标。snap 时吸到同一个框里别的窗口和框的内边（指针进了别的框就看那个框），
   * 还有附近的框的外边和中线（IS-65），画对齐线。重叠不在这里管，松手时再挪。
   */
  moveWindow(id: WindowId, dx: number, dy: number, pointer: Point, opts: DragOptions = {}): void {
    const d = this.drag;
    if (d?.kind === 'move-group' && d.id === id) return this.moveGroup(d, dx, dy, opts);
    if (d?.kind !== 'move-window' || d.id !== id) return;
    const w = this.windowById(id);
    if (!w) return;
    let rect = { ...d.start, x: d.start.x + dx, y: d.start.y + dy };
    const target = dropTargetAt(pointer, this.state.frames, w.workspaceId, d.frameStart);
    let guides: Guide[] = [];
    if (opts.snap && !this.isMaximized(w)) {
      const area = target ? (this.frameOf(target)?.rect ?? null) : d.frameStart;
      const ws = target ?? w.workspaceId;
      const res = snapMove(rect, this.snapTargets(id, ws), {
        threshold: this.snapThreshold(),
        gap: GAP,
        area: area ? innerArea(area) : null,
        alignTo: this.nearbyFrames(area ? union(area, rect) : rect, [ws, w.workspaceId]),
      });
      rect = res.rect;
      guides = res.guides;
    }
    this.set((s) => ({
      dropTarget: target,
      guides,
      windows: s.windows.map((n) => (n.id === id ? { ...n, rect } : n)),
      // 指针在别的框里时自己的框不跟着长（松手会弹回）；否则框跟着窗口变大
      frames:
        d.frameStart && w.workspaceId
          ? s.frames.map((f) => (f.workspaceId === w.workspaceId ? { ...f, rect: target ? d.frameStart! : growFrame(d.frameStart!, this.withGroup(id, rect)) } : f))
          : s.frames,
    }));
  }

  moveWindowEnd(id: WindowId): void {
    const d = this.drag;
    this.drag = null;
    const target = this.state.dropTarget;
    this.set({ lifted: null, dropTarget: null, guides: [] });
    if (d?.kind === 'move-group' && d.id === id) {
      this.moveGroupEnd(d);
      return this.finishDrag(`Move ${d.ids.length} windows`);
    }
    if (d?.kind !== 'move-window' || d.id !== id) return this.finishDrag('Move window');
    const w = this.windowById(id);
    if (!w) return this.finishDrag('Move window');
    this.moveWindowSettle(id, d, w, target);
    this.finishDrag('Move window');
  }

  private moveWindowSettle(id: WindowId, d: Extract<DragSession, { kind: 'move-window' }>, w: WindowNode, target: WorkspaceId | null): void {
    const decision = decideDrop(w, target);
    const maximized = this.isMaximized(w);
    if (decision.kind === 'bounce') {
      const at = { x: w.rect.x, y: w.rect.y };
      this.patchWindow(id, { rect: d.start });
      if (w.workspaceId && d.frameStart) this.patchFrame(w.workspaceId, { rect: d.frameStart });
      this.set({ dialog: { kind: 'move-terminal', windowId: id, to: decision.to, at } });
    } else if (decision.kind === 'adopt') {
      if (w.workspaceId && d.frameStart) this.patchFrame(w.workspaceId, { rect: d.frameStart });
      const to = this.frameOf(decision.workspaceId);
      const rect = maximized ? w.rect : this.freeSpotFor(id, decision.workspaceId, w.rect, to?.rect ?? null);
      this.patchWindow(id, { workspaceId: decision.workspaceId, rect });
      this.fitFrameTo(decision.workspaceId, rect);
    } else if (!maximized) {
      // V3：盖住别的窗口就挪到最近的空位；框按挪好的位置重新长（拖动中是按松手的位置长的），挤到的框挪开
      const rect = this.freeSpotFor(id, w.workspaceId, w.rect, d.frameStart);
      if (!sameRect(rect, w.rect)) this.patchWindow(id, { rect });
      if (w.workspaceId && d.frameStart) this.applyFrameChange(this.layoutBase(), w.workspaceId, d.frameStart, growFrame(d.frameStart, this.withGroup(id, rect)));
    }
  }

  resizeWindowStart(id: WindowId, edge: ResizeEdge): void {
    const w = this.windowById(id);
    if (!w) return;
    this.dragBase = this.layout();
    this.drag = { kind: 'resize-window', id, edge, start: w.rect, frameStart: this.frameOf(w.workspaceId)?.rect ?? null, base: this.layoutBase() };
    this.set({ resizing: { id, rect: w.rect } });
  }

  /** snap 时动的边吸到对齐线、标准间距，宽高吸到同一个框里别的窗口的宽高。框跟着长，挤到的框挪开。 */
  resizeWindow(id: WindowId, dx: number, dy: number, opts: DragOptions = {}): void {
    const d = this.drag;
    if (d?.kind !== 'resize-window' || d.id !== id) return;
    const w = this.windowById(id);
    if (!w) return;
    const min = this.definitionOf(w)?.minSize ?? { w: 160, h: 80 };
    let rect = resizeRect(d.start, d.edge, dx, dy, min);
    let guides: Guide[] = [];
    if (opts.snap) {
      const res = snapResize(rect, d.edge, this.snapTargets(id, w.workspaceId), {
        threshold: this.snapThreshold(),
        gap: GAP,
        area: d.frameStart ? innerArea(d.frameStart) : null,
        min,
      });
      rect = res.rect;
      guides = res.guides;
    }
    this.set({ resizing: { id, rect }, guides });
    if (d.frameStart && w.workspaceId) this.applyFrameChange(d.base, w.workspaceId, d.frameStart, growFrame(d.frameStart, this.withGroup(id, rect)));
  }

  /** 松手才把新大小写进窗口，组件这时才拿到新的 contentSize。 */
  resizeWindowEnd(id: WindowId): void {
    const d = this.drag;
    const live = this.state.resizing;
    this.drag = null;
    this.set({ resizing: null, guides: [] });
    if (d?.kind !== 'resize-window' || d.id !== id || !live) return this.finishDrag('Resize window');
    const w = this.windowById(id);
    if (!w) return this.finishDrag('Resize window');
    this.resizeWindowSettle(id, d, w, live);
    this.finishDrag('Resize window');
  }

  private resizeWindowSettle(id: WindowId, d: Extract<DragSession, { kind: 'resize-window' }>, w: WindowNode, live: { rect: Rect }): void {
    const def = this.definitionOf(w);
    // 拉小到摘要卡：记下拉小前的大小，单击摘要卡时恢复
    let restoreRect = w.restoreRect;
    if (def && isSummarySize(def, live.rect)) {
      if (!isSummarySize(def, d.start)) restoreRect = d.start;
    } else {
      restoreRect = null;
    }
    // V3：改大以后盖住了别的窗口，就挪到最近放得下的地方
    const rect = this.isMaximized(w) ? live.rect : this.freeSpotFor(id, w.workspaceId, live.rect, d.frameStart);
    this.patchWindow(id, { rect, restoreRect });
    if (d.frameStart && w.workspaceId) this.applyFrameChange(d.base, w.workspaceId, d.frameStart, growFrame(d.frameStart, this.withGroup(id, rect)));
  }

  /** 单击摘要卡：拉小的恢复原来的大小；因为白板缩得太小的，缩放到 100% 看它。都会聚焦。 */
  expandSummary(id: WindowId): void {
    const w = this.windowById(id);
    if (!w) return;
    const def = this.definitionOf(w);
    if (def && isSummarySize(def, w.rect) && w.restoreRect) {
      const rect = { ...w.rect, w: w.restoreRect.w, h: w.restoreRect.h };
      this.record('Resize window', () => {
        this.patchWindow(id, { rect, restoreRect: null });
        this.fitFrameTo(w.workspaceId, rect);
      });
      this.focusWindow(id);
      if (this.state.viewport.zoom < SUMMARY_ZOOM) this.centerOn(rect, 1);
      return;
    }
    this.focusWindow(id);
    if (this.state.viewport.zoom < SUMMARY_ZOOM) this.centerOn(w.rect, 1);
  }

  /** 窗口订阅白板发来的命令（WindowComponentProps.onCommand）。 */
  onWindowCommand(id: WindowId, listener: (command: WindowCommand) => void): Unsubscribe {
    let set = this.commandListeners.get(id);
    if (!set) this.commandListeners.set(id, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.commandListeners.delete(id);
    };
  }

  /** 给窗口发命令（⌘K 的 clear、标题栏菜单项）。没有窗口订阅时返回 false。 */
  sendWindowCommand(id: WindowId, command: WindowCommand): boolean {
    const set = this.commandListeners.get(id);
    if (!set || set.size === 0) return false;
    for (const l of [...set]) l(command);
    return true;
  }

  /** 双击标题栏、放大按钮、⌘⇧↩：占满视口（缩放到 100%）；再做一次还原。 */
  toggleMaximize(id: WindowId): void {
    const w = this.windowById(id);
    if (!w) return;
    if (this.isMaximized(w)) {
      const back = w.restoreRect!;
      this.record('Restore window', () => this.patchWindow(id, { rect: back, restoreRect: null }));
      this.focusWindow(id);
      // 还原后窗口回到原来的位置（不挪出它的框），视口平移过去让它停在屏幕中间；不然视口还停在放大时的左上角
      const { pane, viewport } = this.state;
      const zoom = viewport.zoom;
      this.setViewport({ x: pane.w / 2 - (back.x + back.w / 2) * zoom, y: pane.h / 2 - (back.y + back.h / 2) * zoom, zoom }, 200);
      return;
    }
    const { pane } = this.state;
    // PL2：开着 Usage 的终端给上边或下边的用量条留出位置（还有底边的标记）
    const out = this.markOutset(w);
    const rect = {
      x: w.rect.x,
      y: w.rect.y,
      w: Math.max(w.rect.w, pane.w - MAXIMIZE_MARGIN * 2),
      h: Math.max(w.rect.h, pane.h - MAXIMIZE_MARGIN * 2 - out.top - out.bottom),
    };
    this.record('Maximize window', () => this.patchWindow(id, { rect, restoreRect: w.rect }));
    this.focusWindow(id);
    this.setViewport({ x: -rect.x + MAXIMIZE_MARGIN, y: -rect.y + MAXIMIZE_MARGIN + out.top, zoom: 1 }, 200);
  }

  // ---- 拖动：框 ----

  /** 拖框的标题栏：框和里面的窗口一起动。 */
  moveFrameStart(ws: WorkspaceId): void {
    const f = this.frameOf(ws);
    if (!f) return;
    this.dragBase = this.layout();
    this.drag = {
      kind: 'move-frame',
      ws,
      start: f.rect,
      windows: new Map(this.windowsIn(ws).map((w) => [w.id, w.rect])),
      last: f.rect,
    };
  }

  /** 拖框：碰到别的框就停在边上（隔 GAP），可以沿着边滑（V3）。snap 时吸到别的框的边、中线和 GAP 的间距。 */
  moveFrame(ws: WorkspaceId, dx: number, dy: number, opts: DragOptions = {}): void {
    const d = this.drag;
    if (d?.kind !== 'move-frame' || d.ws !== ws) return;
    const others = this.state.frames.filter((f) => f.workspaceId !== ws).map((f) => f.rect);
    let rect = { ...d.start, x: d.start.x + dx, y: d.start.y + dy };
    if (opts.snap) rect = snapMove(rect, others, { threshold: this.snapThreshold(), gap: GAP }).rect;
    rect = clampFrameMove(d.last, rect, others, GAP);
    d.last = rect;
    // 线按停下来的位置画：停在别的框边上时也标出间距
    const guides = opts.snap ? snapMove(rect, others, { threshold: 1e-3, gap: GAP }).guides : [];
    const mx = rect.x - d.start.x;
    const my = rect.y - d.start.y;
    this.set((s) => ({
      guides,
      frames: s.frames.map((f) => (f.workspaceId === ws ? { ...f, rect } : f)),
      windows: s.windows.map((w) => {
        const r = d.windows.get(w.id);
        if (!r) return w;
        const rect2 = { ...r, x: r.x + mx, y: r.y + my };
        const restoreRect = w.restoreRect ? { ...w.restoreRect, x: w.restoreRect.x + rect2.x - w.rect.x, y: w.restoreRect.y + rect2.y - w.rect.y } : null;
        return { ...w, rect: rect2, restoreRect };
      }),
    }));
  }

  moveFrameEnd(): void {
    this.drag = null;
    if (this.state.guides.length > 0) this.set({ guides: [] });
    this.finishDrag('Move workspace');
  }

  resizeFrameStart(ws: WorkspaceId, edge: ResizeEdge): void {
    const f = this.frameOf(ws);
    if (!f) return;
    this.dragBase = this.layout();
    this.drag = { kind: 'resize-frame', ws, edge, start: f.rect, content: this.contentBounds(ws), base: this.layoutBase() };
  }

  /**
   * 拖框的边：挤到的框挪开，再拉小时回到原处（V3）。snap 时（IS-65，和改窗口大小一样）动的边吸到别的框的边、
   * 隔 GAP 的位置、同宽同高，还有正好装下里面窗口的位置；吸附不去挤别的框（挤开是用户拖过去的，不是吸过去的）。
   */
  resizeFrame(ws: WorkspaceId, dx: number, dy: number, opts: DragOptions = {}): void {
    const d = this.drag;
    if (d?.kind !== 'resize-frame' || d.ws !== ws) return;
    let rect = resizeFrame(d.start, d.edge, dx, dy, d.content);
    let guides: Guide[] = [];
    if (opts.snap) {
      // 不吸时就会被挤开的框不当吸附对象：它的位置跟着这个框变。别的框按拖动前的位置算
      const pushed = pushFrames(d.base.frames, { id: ws, before: d.start, after: rect }, GAP);
      const others = [...d.base.frames].filter(([k]) => k !== ws && !pushed.has(k)).map(([, r]) => r);
      const res = snapResize(rect, d.edge, others, {
        threshold: this.snapThreshold(),
        gap: GAP,
        min: FRAME_MIN,
        fit: d.content ? { content: d.content, frame: frameAround(d.content) } : null,
        keepApart: GAP,
      });
      rect = res.rect;
      guides = res.guides;
    }
    if (guides.length > 0 || this.state.guides.length > 0) this.set({ guides });
    this.applyFrameChange(d.base, ws, d.start, rect);
  }

  resizeFrameEnd(): void {
    this.drag = null;
    if (this.state.guides.length > 0) this.set({ guides: [] });
    this.finishDrag('Resize workspace');
  }

  // ---- 视口 ----

  setPane(size: Size): void {
    const p = this.state.pane;
    if (p.w !== size.w || p.h !== size.h) this.set({ pane: size });
  }

  /** React Flow 的视口变了（平移、缩放）。 */
  viewportChanged(vp: Viewport): void {
    const cur = this.state.viewport;
    if (cur.x !== vp.x || cur.y !== vp.y || cur.zoom !== vp.zoom) this.set({ viewport: vp });
  }

  private setViewport(vp: Viewport, duration = 0): void {
    if (this.viewportApi) this.viewportApi.setViewport(vp, { duration });
    else this.viewportChanged(vp);
  }

  /** 屏幕坐标（clientX / clientY）→ 白板坐标。按 store 里的视口算，和画出来的一致。 */
  clientToFlow(p: Point): Point {
    const o = this.viewportApi?.origin() ?? { x: 0, y: 0 };
    return toFlow(this.state.viewport, { x: p.x - o.x, y: p.y - o.y });
  }

  zoomTo(zoom: number): void {
    const s = this.state;
    this.setViewport(zoomAroundCenter(s.viewport, s.pane, zoom), 150);
  }

  zoomBy(factor: number): void {
    this.zoomTo(this.state.viewport.zoom * factor);
  }

  /** ⌘1 “Show all”：所有框和窗口都放进视口，最大 100%。 */
  showAll(): void {
    const s = this.state;
    const all = bounds([...s.frames.map((f) => f.rect), ...s.windows.map((w) => w.rect)]);
    if (!all) return this.setViewport({ x: 0, y: 0, zoom: 1 }, 200);
    this.setViewport(fitViewport(all, s.pane, { maxZoom: 1 }), 200);
  }

  /** 双击框的标题栏：让这个框占满视口（最大 100%）。 */
  fitFrame(ws: WorkspaceId): void {
    const f = this.frameOf(ws);
    if (f) this.setViewport(fitViewport(f.rect, this.state.pane, { maxZoom: 1, padding: 24 }), 200);
  }

  private centerOn(rect: Rect, zoom: number): void {
    const { pane } = this.state;
    const c = center(rect);
    this.setViewport({ x: pane.w / 2 - c.x * zoom, y: pane.h / 2 - c.y * zoom, zoom }, 200);
  }

  /** 跳到窗口并聚焦：已经完整看得见就不动视口，否则平移缩放让它完整显示（最大 100%）。 */
  jumpToWindow(id: WindowId): void {
    // N2：收起的子终端（⌘J、通知、快速定位跳到它）先显示出来，贴在侧边栏右边
    if (hiddenMembers(this.state.windows).has(id)) this.showGroupMember(id);
    const w = this.windowById(id);
    if (!w) return;
    const s = this.state;
    const vis = visibleRect(s.viewport, s.pane);
    const fully = w.rect.x >= vis.x && w.rect.y >= vis.y && w.rect.x + w.rect.w <= vis.x + vis.w && w.rect.y + w.rect.h <= vis.y + vis.h;
    if (!fully || s.viewport.zoom < SUMMARY_ZOOM) this.setViewport(fitViewport(w.rect, s.pane, { maxZoom: 1 }), 220);
    this.focusWindow(id);
  }

  /** ⌘J、顶栏的“n waiting”：依次跳到每个在等你的窗口（最早开始等的在前），跳到的窗口闪一下。 */
  jumpToNextWaiting(): WindowId | null {
    const next = nextWaiting(this.attention().waiting, this.state.focusedId);
    if (next) this.jumpAndFlash(next);
    return next;
  }

  /** ⌘⇧J：反方向。 */
  jumpToPrevWaiting(): WindowId | null {
    const prev = prevWaiting(this.attention().waiting, this.state.focusedId);
    if (prev) this.jumpAndFlash(prev);
    return prev;
  }

  /** ⌘⇧] / ⌘⇧[：按位置切到下一个 / 上一个窗口（见 model/navigation.ts）。 */
  jumpToAdjacentWindow(step: 1 | -1): WindowId | null {
    const s = this.state;
    const order = windowOrder(s.windows, s.frames);
    const frameStart = s.selectedFrame ? (order.find((id) => this.windowById(id)?.workspaceId === s.selectedFrame) ?? null) : null;
    const target = adjacentWindow(order, s.focusedId, step, frameStart);
    if (target) this.jumpToWindow(target);
    return target;
  }

  /** 跳过去、闪一下并聚焦（⌘J 的效果）。面板的快速定位列表（V5）也用它。 */
  jumpAndFlash(id: WindowId): void {
    this.flashWindow(id);
    this.jumpToWindow(id);
  }

  private flashWindow(id: WindowId): void {
    this.set((s) => ({ flash: { ...s.flash, [id]: (s.flash[id] ?? 0) + 1 } }));
  }

  togglePanel(): void {
    this.set((s) => ({ panel: { ...s.panel, open: !s.panel.open } }));
  }

  /** 右侧面板宽度 280–480（需求「1 · 整体布局」）。 */
  setPanelWidth(width: number): void {
    const w = Math.round(Math.min(480, Math.max(280, width)));
    if (w !== this.state.panel.width) this.set((s) => ({ panel: { ...s.panel, width: w } }));
  }

  // ---- 新建窗口 ----

  /** 视口中心（白板坐标）。 */
  viewportCenter(): Point {
    return center(visibleRect(this.state.viewport, this.state.pane));
  }

  /**
   * 新窗口放哪：给了 at 放在 at（右键的位置）；给了 nextTo 放在它右边；在框里就放在框里最后一个窗口右边或框的左上角；
   * 都没有就在视口中心。
   */
  placeWindow(size: Size, ws: WorkspaceId | null, opts: { at?: Point | null; nextTo?: WindowId | null } = {}): Rect {
    if (opts.at) return { x: opts.at.x, y: opts.at.y, w: size.w, h: size.h };
    const near = opts.nextTo ? this.windowById(opts.nextTo) : undefined;
    if (near) return { x: near.rect.x + near.rect.w + GAP, y: near.rect.y, w: size.w, h: size.h };
    const frame = this.frameOf(ws);
    if (frame) {
      const inside = this.windowsIn(frame.workspaceId);
      if (inside.length === 0) return { x: frame.rect.x + FRAME_PAD, y: frame.rect.y + FRAME_HEADER, w: size.w, h: size.h };
      const last = inside.reduce((a, b) => (b.z > a.z ? b : a));
      return { x: last.rect.x + last.rect.w + GAP, y: last.rect.y, w: size.w, h: size.h };
    }
    const c = this.viewportCenter();
    return { x: Math.round(c.x - size.w / 2), y: Math.round(c.y - size.h / 2), w: size.w, h: size.h };
  }

  /** 加一个窗口：放进框（框跟着变大），提到最上层并聚焦。 */
  addWindow<TData>(init: { type: string; workspaceId: WorkspaceId | null; rect: Rect; data: TData; title?: string | null; exact?: boolean }): WindowId {
    const id = newWindowId();
    // V3：放的位置盖住了别的窗口就挪到最近的空位。exact（N2 停靠的子终端）：就放在那里，框不跟着长（由调用方处理）
    const rect = init.exact ? init.rect : this.freeSpotFor(null, init.workspaceId, init.rect, this.frameOf(init.workspaceId)?.rect ?? null);
    const node: WindowNode = {
      id,
      type: init.type,
      workspaceId: init.workspaceId,
      rect,
      z: this.maxWindowZ() + 1,
      title: init.title ?? null,
      restoreRect: null,
      data: init.data,
    };
    this.set((s) => ({ windows: [...s.windows, node] }));
    if (!init.exact) this.fitFrameTo(init.workspaceId, rect);
    this.focusWindow(id);
    return id;
  }

  /**
   * 新建终端（New terminal ▸、⌘N、框里的初始化命令、W5 的 Open new、X4 的 Fork）。框里的目录是工作区目录，散放时是主目录。
   * mode 默认新对话；X4 传 fork（agent 自己把原来的对话复制成新会话，原来的不动）。
   */
  async newTerminal(opts: {
    agent: AgentKind;
    workspaceId: WorkspaceId | null;
    at?: Point | null;
    nextTo?: WindowId | null;
    /** Shell 或自定义命令要运行的命令。 */
    command?: string;
    cwd?: string;
    title?: string | null;
    mode?: LaunchMode;
  }): Promise<WindowId | null> {
    const def = this.registry.get(TERMINAL_TYPE) as WindowDefinition<TerminalWindowData> | undefined;
    if (!def) {
      this.notify('Terminal windows are not available');
      return null;
    }
    const ws = opts.workspaceId ? this.state.workspaces[opts.workspaceId] : undefined;
    const cwd = opts.cwd ?? ws?.path ?? this.opts.homeDir ?? '~';
    const rect = this.placeWindow(def.defaultSize, opts.workspaceId, { at: opts.at ?? null, nextTo: opts.nextTo ?? null });
    try {
      const res = await this.api.agents.start({
        agent: opts.agent,
        cwd,
        workspaceId: opts.workspaceId,
        mode: opts.mode ?? { kind: 'new' },
        size: estimateTermSize(this.contentSizeOf(rect)),
        ...(opts.command !== undefined ? { command: opts.command } : {}),
      });
      const data = def.create({
        terminalId: res.terminalId,
        agent: opts.agent,
        cmd: res.cmd,
        args: res.args,
        cwd,
        sessionId: res.sessionId,
        startCommand: opts.command ?? null,
      });
      return this.addWindow({ type: TERMINAL_TYPE, workspaceId: opts.workspaceId, rect, data, title: opts.title ?? null });
    } catch (e) {
      this.notify(errorMessage(e));
      return null;
    }
  }

  /** 新建网页窗口（New browser、⌘T）。 */
  newBrowser(opts: { workspaceId: WorkspaceId | null; at?: Point | null; nextTo?: WindowId | null }): WindowId | null {
    const def = this.registry.get(BROWSER_TYPE);
    if (!def) {
      this.notify('Browser windows are not available');
      return null;
    }
    const rect = this.placeWindow(def.defaultSize, opts.workspaceId, { at: opts.at ?? null, nextTo: opts.nextTo ?? null });
    return this.addWindow({ type: BROWSER_TYPE, workspaceId: opts.workspaceId, rect, data: def.create({}) });
  }

  /**
   * 窗口组件调 props.openWindow：同 reuseKey 的已经开着就聚焦它并闪一下，否则开在发起窗口右边、同一个工作区。
   * quiet：不聚焦、不移动视口（服务开的窗口，见 openWindowFromService）。
   */
  openWindow(fromId: WindowId | null, req: OpenWindowRequest, opts: { quiet?: boolean; exact?: boolean } = {}): WindowId | null {
    const def = this.registry.get(req.type);
    if (!def) {
      this.notify(`Can’t open a ${req.type} window`);
      return null;
    }
    // reuseKey 存在窗口上（WindowNode.reuseKey），随白板保存，重启后同一地址仍然复用（N1：open_browser 同一来源跳过去刷新）
    if (req.reuseKey) {
      const existing = this.state.windows.find((w) => w.type === req.type && w.reuseKey === req.reuseKey);
      if (existing) {
        this.updateData(existing.id, req.data as object);
        if (opts.quiet) this.flashWindow(existing.id);
        else this.jumpAndFlash(existing.id);
        return existing.id;
      }
    }
    const from = fromId ? this.windowById(fromId) : undefined;
    const ws = req.workspaceId === undefined ? (from?.workspaceId ?? null) : req.workspaceId;
    const placed = this.placeWindow(def.defaultSize, ws, { nextTo: from?.id ?? null });
    const rect = { ...placed, ...req.rect };
    const { focusedId, selectedFrame } = this.state;
    const id = this.addWindow({ type: req.type, workspaceId: ws, rect, data: def.create(req.data as never), ...(opts.exact ? { exact: true } : {}) });
    if (opts.quiet) this.set({ focusedId, selectedFrame });
    if (req.reuseKey) this.patchWindow(id, { reuseKey: req.reuseKey });
    return id;
  }

  // ---- 服务让白板做的事（M1：agent 通过 MCP 开终端、工作区、网页） ----
  // 终端和工作区已经由服务建好，这里只放上白板。不抢键盘焦点、不动视口：用户可能正在别的窗口里打字。

  /** board.add-frame：工作区放到空位上；已经有框时不动。 */
  addFrameFromService(workspace: Workspace): void {
    this.set((s) => ({ workspaces: { ...s.workspaces, [workspace.id]: workspace } }));
    if (this.frameOf(workspace.id)) return;
    const rect = this.freeFrameRect(this.defaultFrameSize());
    this.set((s) => ({ frames: [...s.frames, { workspaceId: workspace.id, rect, z: this.maxFrameZ() + 1, autoApprove: false }] }));
  }

  /**
   * board.open-window：照 openWindow 放进框里（框不在白板上时散放）；highlight 时闪一下。
   * nearTerminal（N1，open_browser 的调用者）的窗口在同一个框里时放在它右边。
   */
  openWindowFromService(req: OpenWindowRequest, highlight: boolean, nearTerminal: TerminalId | null = null): WindowId | null {
    const workspaceId = this.onBoardWorkspace(req.workspaceId ?? null);
    const near = this.windowOfTerminal(nearTerminal);
    const from = near && near.workspaceId === workspaceId ? near.id : null;
    const id = this.openWindow(from, { ...req, workspaceId }, { quiet: true });
    if (id && highlight) this.flashWindow(id);
    return id;
  }

  /**
   * board.open-group（N1 open_terminals）：一组终端放在 lead 的窗口右边，按网格排（3 个是 2×2 缺一、6 个是 3×2），
   * 盖住别的窗口时照常挪到空位；然后记进窗口组（WindowNode.group）。lead 已经在组里（它自己是别人开的子终端）时加进那个组。
   * 找不到 lead 的窗口时只是依次放进框里，不成组。不抢焦点、不动视口。
   */
  openGroupFromService(lead: TerminalId | null, members: readonly WindowGroupMemberRequest[], highlight: boolean): WindowId[] {
    const leadWin = this.windowOfTerminal(lead);
    // N2：侧边栏挂在组的 lead 旁边（调用者自己是子终端时是它那一组的 lead）。新组只显示第一个子终端，贴在侧边栏右边，
    // 其余收起；已有的组照它现在的显示方式（Show all 时照 N1 平铺）
    const current = leadWin?.group ?? null;
    const existing = current ? listGroups(this.state.windows).find((g) => g.id === current.id) : undefined;
    const anchor = existing?.lead ?? leadWin;
    const docked = !!anchor && (!existing || groupView(existing).mode !== 'all');
    const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    const ids: WindowId[] = [];
    members.forEach((m, i) => {
      const workspaceId = this.onBoardWorkspace(m.request.workspaceId ?? null);
      const size = this.registry.get(m.request.type)?.defaultSize ?? FALLBACK_SIZE;
      let rect = m.request.rect;
      let exact = false;
      if (docked && anchor && anchor.workspaceId === workspaceId && !rect) {
        // 停靠处：选中的那个显示在这里，收起的也停在这里（不占别处的地方，框不为看不见的窗口长大）
        rect = { ...dockSlot(this.footprint(anchor)), ...size };
        exact = true;
      }
      const beside = leadWin && leadWin.workspaceId === workspaceId ? leadWin : null;
      if (beside && !rect) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const left = beside.id === anchor?.id ? dockSlot(this.footprint(beside)).x : beside.rect.x + beside.rect.w + GAP;
        rect = {
          x: left + col * (size.w + GAP),
          y: beside.rect.y + row * (size.h + GAP),
        };
      }
      const id = this.openWindow(null, { ...m.request, workspaceId, ...(rect ? { rect } : {}) }, { quiet: true, exact });
      if (!id) return;
      ids.push(id);
      if (highlight) this.flashWindow(id);
    });
    if (leadWin && ids.length > 0) {
      const groupId = current?.id ?? newGroupId();
      const labels = new Map(ids.map((id, i) => [id, members[i]?.label ?? null]));
      this.set((s) => ({
        windows: s.windows.map((w) => {
          if (w.id === leadWin.id && !current) return { ...w, group: { id: groupId, role: 'lead', label: null, view: { mode: 'one', shown: ids[0]! } } };
          if (labels.has(w.id)) return { ...w, group: { id: groupId, role: 'member', label: labels.get(w.id) ?? null } };
          return w;
        }),
      }));
      if (docked) this.settleGroup(groupId);
    }
    return ids;
  }

  // ---- 后台 agent（N10） ----

  private setBackgroundAgents(terminalId: TerminalId, agents: BackgroundAgent[]): void {
    const before = this.state.backgroundPanels;
    this.set((s) => {
      const backgroundAgents = { ...s.backgroundAgents };
      if (agents.length > 0) backgroundAgents[terminalId] = agents;
      else delete backgroundAgents[terminalId];
      // 一个都没有了（终端关了、agent 退出了）：它的面板也收起
      let backgroundPanels = s.backgroundPanels;
      if (agents.length === 0) {
        const gone = s.windows.filter((w) => terminalIdOf(w) === terminalId && s.backgroundPanels[w.id]).map((w) => w.id);
        if (gone.length > 0) {
          backgroundPanels = { ...s.backgroundPanels };
          for (const id of gone) delete backgroundPanels[id];
        }
      } else {
        // 选中的那个不在了：只收起记录窗口
        for (const w of s.windows) {
          const p = s.backgroundPanels[w.id];
          if (p?.selected && terminalIdOf(w) === terminalId && !agents.some((a) => a.id === p.selected)) {
            backgroundPanels = { ...backgroundPanels, [w.id]: { selected: null } };
          }
        }
      }
      return { backgroundAgents, backgroundPanels };
    });
    const after = this.state.backgroundPanels;
    for (const id of Object.keys(before) as WindowId[]) {
      if (!after[id]) this.unfitPanel(id);
      else if (after[id] !== before[id]) this.fitPanel(id);
    }
  }

  /** 这个主终端的后台 agent（按开始的先后）。不是终端、没有时为空。 */
  backgroundAgentsOf(windowId: WindowId): BackgroundAgent[] {
    const w = this.windowById(windowId);
    const tid = w ? terminalIdOf(w) : null;
    return tid ? (this.state.backgroundAgents[tid] ?? []) : [];
  }

  /** 点小提示：面板开着就收起，收着就打开。 */
  toggleBackgroundPanel(windowId: WindowId): void {
    if (this.state.backgroundPanels[windowId]) this.closeBackgroundPanel(windowId);
    else this.openBackgroundPanel(windowId);
  }

  /** 打开后台 agent 的侧边栏（右键菜单的 Background agents… 也走这里）。 */
  openBackgroundPanel(windowId: WindowId): void {
    if (!this.windowById(windowId) || this.state.backgroundPanels[windowId]) return;
    this.set((s) => ({ backgroundPanels: { ...s.backgroundPanels, [windowId]: { selected: null } } }));
    this.fitPanel(windowId);
  }

  closeBackgroundPanel(windowId: WindowId): void {
    if (!this.state.backgroundPanels[windowId]) return;
    this.set((s) => {
      const backgroundPanels = { ...s.backgroundPanels };
      delete backgroundPanels[windowId];
      return { backgroundPanels };
    });
    this.unfitPanel(windowId);
  }

  /**
   * 侧边栏单击一个后台 agent：右边打开它的记录（只读），再点一次收起。主终端是窗口组的 lead 时，
   * 记录窗口占的是子终端的停靠处，所以先把子终端收起（Collapse group，进程照常运行）。
   */
  selectBackgroundAgent(windowId: WindowId, agentId: string): void {
    const panel = this.state.backgroundPanels[windowId] ?? { selected: null };
    const selected = panel.selected === agentId ? null : agentId;
    const g = groupOf(this.state.windows, windowId);
    this.set((s) => ({
      backgroundPanels: { ...s.backgroundPanels, [windowId]: { selected } },
      ...(selected && g && g.lead.id === windowId && groupView(g).mode !== 'collapsed'
        ? { windows: setGroupView(s.windows, g.id, { mode: 'collapsed' }) }
        : {}),
    }));
    this.fitPanel(windowId);
  }

  /** 面板打开时框原来的样子；收起时还原（这期间布局没被别的操作改过才还原）。 */
  private panelFits = new Map<WindowId, { ws: WorkspaceId; before: Rect; base: LayoutBase; moved: Map<WindowId, Rect>; applied: string }>();

  private layoutKey(): string {
    const s = this.state;
    return JSON.stringify([s.frames.map((f) => [f.workspaceId, f.rect]), s.windows.map((w) => [w.id, w.workspaceId, w.rect])]);
  }

  /**
   * 后台 agent 面板开了、换了选中的：框长到装下侧边栏和记录窗口，挤到的框挪开，框里被盖住的窗口挪到最近的空位。
   * 记下打开前的框和布局，收起时（unfitPanel）照原样放回去。
   */
  private fitPanel(windowId: WindowId): void {
    const w = this.windowById(windowId);
    const ws = w?.workspaceId ?? null;
    const f = this.frameOf(ws);
    if (!w || !ws || !f || this.isMaximized(w)) return;
    let rec = this.panelFits.get(windowId);
    if (!rec || rec.applied !== this.layoutKey()) rec = { ws, before: f.rect, base: this.layoutBase(), moved: new Map(), applied: '' };
    // 上次挪开的窗口先放回原处，再按现在的面板重新算
    const back = rec.moved;
    if (back.size > 0) this.set((s) => ({ windows: s.windows.map((x) => (back.has(x.id) ? { ...x, rect: back.get(x.id)! } : x)) }));
    const anchor = this.footprint(w);
    const own = this.withGroup(windowId, anchor);
    const panel = this.state.backgroundPanels[windowId];
    const g = this.leadGroup(windowId);
    const parts = [...(panel && !g ? [sidebarRect(anchor)] : []), ...(panel?.selected ? [transcriptRect(anchor)] : [])];
    const moved = new Map<WindowId, Rect>();
    const placed: Rect[] = [];
    if (parts.length > 0) {
      const hidden = hiddenMembers(this.state.windows);
      const skip = new Set(g ? [g.lead.id, ...g.members.map((m) => m.id)] : [windowId]);
      const grownFrame = growFrame(rec.before, own);
      for (const o of this.state.windows) {
        if (o.workspaceId !== ws || skip.has(o.id) || hidden.has(o.id) || this.isMaximized(o)) continue;
        if (!parts.some((p) => intersects(p, this.obstacleRect(o)))) continue;
        const others = this.state.windows
          .filter((x) => x.id !== o.id && x.workspaceId === ws && !skip.has(x.id) && !hidden.has(x.id) && !moved.has(x.id))
          .map((x) => this.obstacleRect(x));
        const at = this.obstacleRect(o);
        const spot = findFreeSpot(at, [own, ...others, ...placed, ...this.sidebarObstacles(ws, o.id)], { gap: GAP, area: innerArea(grownFrame) });
        const r = { ...o.rect, x: o.rect.x + spot.x - at.x, y: o.rect.y + spot.y - at.y };
        moved.set(o.id, o.rect);
        placed.push(spot);
        this.patchWindow(o.id, { rect: r });
      }
    }
    const need = bounds([own, ...placed]) ?? own;
    this.applyFrameChange(rec.base, ws, rec.before, growFrame(rec.before, need));
    rec.moved = moved;
    rec.applied = this.layoutKey();
    this.panelFits.set(windowId, rec);
  }

  /** 面板收起了：框缩回打开前的大小，挤开的框、挪开的窗口回原处。期间布局被别的操作改过就不动（以免把东西挪乱）。 */
  private unfitPanel(windowId: WindowId): void {
    const rec = this.panelFits.get(windowId);
    this.panelFits.delete(windowId);
    if (!rec || rec.applied !== this.layoutKey()) return;
    const back = rec.moved;
    if (back.size > 0) this.set((s) => ({ windows: s.windows.map((x) => (back.has(x.id) ? { ...x, rect: back.get(x.id)! } : x)) }));
    this.applyFrameChange(rec.base, rec.ws, rec.before, rec.before);
  }

  /** 框里每个窗口连同标记、Usage 条、侧边栏、面板都要装得下；装不下就让框长（只变大）。拖动中不管（拖动自己会长框）。 */
  private keepMarksInFrames(): void {
    const s = this.state;
    if (!s.loaded || this.drag) return;
    const hidden = hiddenMembers(s.windows);
    for (const w of s.windows) {
      if (!w.workspaceId || hidden.has(w.id) || this.isMaximized(w)) continue;
      const f = this.frameOf(w.workspaceId);
      if (!f) continue;
      const ext = this.withGroup(w.id, w.rect);
      if (!sameRect(growFrame(f.rect, ext), f.rect)) this.fitFrameTo(w.workspaceId, ext);
    }
  }

  // ---- 项目框一键排版（N12，画板 15） ----

  /** 框的排版设置（老数据没有，按关着、没点过）。 */
  frameArrange(ws: WorkspaceId): FrameArrange {
    return this.frameOf(ws)?.arrange ?? { auto: false, layout: null };
  }

  /** 框标题右上角的 Tidy / Columns / Rows：排好、框缩到正好装下，记成一步（⌘Z 回到排之前）。 */
  arrangeFrame(ws: WorkspaceId, layout: FrameLayout): void {
    if (!this.frameOf(ws)) return;
    this.record(`Arrange windows (${LAYOUT_LABEL[layout]})`, () => {
      this.layoutFrame(ws, layout, new Set());
      this.patchFrame(ws, { arrange: { ...this.frameArrange(ws), layout } });
    });
  }

  /** Auto-arrange 开关。打开时马上按上次的排法（没点过按 Tidy）排一次。 */
  setAutoArrange(ws: WorkspaceId, on: boolean): void {
    if (!this.frameOf(ws)) return;
    this.patchFrame(ws, { arrange: { ...this.frameArrange(ws), auto: on } });
    if (on) this.record('Arrange windows', () => this.layoutFrame(ws, this.frameArrange(ws).layout ?? 'tidy', new Set()));
  }

  /** 每个框里有哪些窗口（上一次看到的），Auto-arrange 据此知道新开、关掉了窗口。 */
  private frameMembers = new Map<WorkspaceId, Set<WindowId>>();
  /** 等着重排的框和新开的窗口（拖动中先不排，松手后再排）。 */
  private pendingArrange = new Map<WorkspaceId, Set<WindowId>>();
  private arrangeQueued = false;

  private noteFrameMembers(): void {
    const s = this.state;
    if (!s.loaded) return;
    const now = new Map<WorkspaceId, Set<WindowId>>();
    for (const w of s.windows) if (w.workspaceId) (now.get(w.workspaceId) ?? now.set(w.workspaceId, new Set()).get(w.workspaceId)!).add(w.id);
    for (const f of s.frames) {
      const ws = f.workspaceId;
      const cur = now.get(ws) ?? new Set<WindowId>();
      const prev = this.frameMembers.get(ws);
      this.frameMembers.set(ws, cur);
      if (!prev || !f.arrange?.auto) continue;
      const added = [...cur].filter((id) => !prev.has(id));
      const removed = [...prev].some((id) => !cur.has(id));
      if (added.length === 0 && !removed) continue;
      const pending = this.pendingArrange.get(ws) ?? new Set<WindowId>();
      for (const id of added) pending.add(id);
      this.pendingArrange.set(ws, pending);
    }
    if (this.pendingArrange.size === 0 || this.arrangeQueued) return;
    this.arrangeQueued = true;
    queueMicrotask(() => {
      this.arrangeQueued = false;
      if (!this.started || this.drag) return;
      const jobs = [...this.pendingArrange];
      this.pendingArrange.clear();
      for (const [ws, added] of jobs) {
        const a = this.frameArrange(ws);
        if (a.auto && this.frameOf(ws)) this.layoutFrame(ws, a.layout ?? 'tidy', added);
      }
    });
  }

  /**
   * 排一个框：框里每个窗口连同贴着它的东西（withGroup）算一块，按 layout 排到框内区域的左上角起，然后框缩到正好装下
   * （挤到或空出来的旁边的框照 V3 的规则）。放大中的、收起的子终端不动；停靠的子终端跟着 lead 走。last：新开的，排在最后。
   */
  private layoutFrame(ws: WorkspaceId, layout: FrameLayout, last: ReadonlySet<WindowId>): void {
    const f = this.frameOf(ws);
    if (!f) return;
    const s = this.state;
    const hidden = hiddenMembers(s.windows);
    const docked = new Set<WindowId>();
    for (const g of listGroups(s.windows)) {
      const m = this.dockedMember(g);
      if (m) docked.add(m.id);
    }
    const blocks: ArrangeBlock[] = [];
    for (const w of s.windows) {
      if (w.workspaceId !== ws || hidden.has(w.id) || docked.has(w.id) || this.isMaximized(w)) continue;
      const g = this.leadGroup(w.id);
      blocks.push({
        id: w.id,
        ext: this.withGroup(w.id, w.rect),
        rect: w.rect,
        min: this.definitionOf(w)?.minSize ?? FRAME_MIN,
        resizable: !(g && this.dockedMember(g)),
        last: last.has(w.id),
      });
    }
    if (blocks.length === 0) return;
    const inner = innerArea(f.rect);
    const placed = arrangeBlocks(layout, blocks, { x: inner.x, y: inner.y }, GAP);
    this.set((st) => ({
      windows: st.windows.map((w) => {
        const r = placed.get(w.id);
        return r && !sameRect(r, w.rect) ? { ...w, rect: r } : w;
      }),
    }));
    // 框缩到正好装下（不小于 FRAME_MIN），左上角不动
    const st = this.state;
    const hid = hiddenMembers(st.windows);
    const content = bounds(st.windows.filter((w) => w.workspaceId === ws && !hid.has(w.id)).map((w) => this.withGroup(w.id, this.footprint(w))));
    const before = this.frameOf(ws)?.rect;
    if (!content || !before) return;
    const fit = frameAround(content);
    const after = { ...fit, w: Math.max(FRAME_MIN.w, fit.w), h: Math.max(FRAME_MIN.h, fit.h) };
    if (!sameRect(after, before)) this.applyFrameChange(this.layoutBase(), ws, before, after);
  }

  // ---- 窗口组的侧边栏（N2） ----

  /** 侧边栏单击一行：只显示这个子终端（贴在侧边栏右边），其余收起；跳过去并聚焦。 */
  selectGroupMember(id: WindowId): void {
    this.record('Show subagent', () => this.showGroupMember(id));
    this.jumpToWindow(id);
  }

  /** 只显示这个子终端，贴在侧边栏右边，其余收起；挡住的窗口挪开，框跟着长。不动焦点和视口。 */
  showGroupMember(id: WindowId): void {
    const g = groupOf(this.state.windows, id);
    const member = g?.members.find((m) => m.id === id);
    if (!g || !member) return;
    const slot = dockSlot(this.footprint(g.lead));
    const dock = dockable(g.lead, member);
    this.set((s) => {
      const windows = setGroupView(s.windows, g.id, { mode: 'one', shown: id }).map((w) =>
        w.id === id && dock ? { ...w, rect: { ...w.rect, x: slot.x, y: slot.y } } : w,
      );
      // N10：停靠处换成子终端，后台 agent 的记录窗口收起
      const panel = s.backgroundPanels[g.lead.id];
      return {
        windows,
        focusedId: s.focusedId && s.focusedId !== id && hiddenMembers(windows).has(s.focusedId) ? null : s.focusedId,
        ...(panel?.selected ? { backgroundPanels: { ...s.backgroundPanels, [g.lead.id]: { selected: null } } } : {}),
      };
    });
    this.settleGroup(g.id);
  }

  /** Show all：子终端都显示，平铺在侧边栏右边（列数 ⌈√n⌉），盖住别的窗口时挪到最近的空位；框跟着长。 */
  showAllGroup(groupId: WindowGroupId): void {
    this.record('Show all subagents', () => this.tileGroup(groupId));
  }

  private tileGroup(groupId: WindowGroupId): void {
    const s = this.state;
    const g = listGroups(s.windows).find((x) => x.id === groupId);
    if (!g) return;
    const ws = g.lead.workspaceId;
    const anchor = this.footprint(g.lead);
    const slot = dockSlot(anchor);
    const dock = g.members.filter((m) => dockable(g.lead, m));
    const cols = Math.max(1, Math.ceil(Math.sqrt(dock.length)));
    const cellW = Math.max(0, ...dock.map((m) => m.rect.w)) + GAP;
    const cellH = Math.max(0, ...dock.map((m) => m.rect.h)) + GAP;
    const inGroup = new Set(g.members.map((m) => m.id));
    const hidden = hiddenMembers(s.windows);
    const fixed = [
      ...s.windows.filter((w) => w.workspaceId === ws && w.id !== g.lead.id && !inGroup.has(w.id) && !hidden.has(w.id)).map((w) => this.footprint(w)),
      union(anchor, sidebarRect(anchor)),
      ...this.sidebarObstacles(ws, g.lead.id),
    ];
    const rects = new Map<WindowId, Rect>();
    dock.forEach((m, i) => {
      // 不限在框里：离网格的位置最近就行（框跟着长），平铺的样子不被框里别处的空位打乱
      const want = { ...m.rect, x: slot.x + (i % cols) * cellW, y: slot.y + Math.floor(i / cols) * cellH };
      const r = findFreeSpot(want, [...fixed, ...rects.values()], { gap: GAP });
      rects.set(m.id, r);
    });
    this.set((st) => ({
      windows: setGroupView(st.windows, groupId, { mode: 'all' }).map((w) => {
        const r = rects.get(w.id);
        return r ? { ...w, rect: r } : w;
      }),
    }));
    const all = bounds([...rects.values(), this.withGroup(g.lead.id, anchor)]);
    if (all) this.fitFrameTo(ws, all);
  }

  /** Collapse group：子终端都收起，只剩侧边栏。聚焦在子终端上时取消聚焦。 */
  collapseGroup(groupId: WindowGroupId): void {
    this.record('Collapse group', () => this.foldGroup(groupId));
  }

  private foldGroup(groupId: WindowGroupId): void {
    this.set((s) => {
      const windows = setGroupView(s.windows, groupId, { mode: 'collapsed' });
      return { windows, focusedId: s.focusedId && hiddenMembers(windows).has(s.focusedId) ? null : s.focusedId };
    });
  }

  /** id 是组的 lead 时，那一组。 */
  private leadGroup(id: WindowId): WindowGroup | undefined {
    return listGroups(this.state.windows).find((g) => g.lead.id === id);
  }

  /** 选中的、正停在停靠处的子终端（lead 挪动时跟着走，算在 lead 占的地方里）。 */
  private dockedMember(g: WindowGroup): WindowNode | null {
    const v = groupView(g);
    if (v.mode !== 'one') return null;
    const m = g.members.find((x) => x.id === v.shown);
    return m && dockable(g.lead, m) && atSlot(m.rect, dockSlot(this.footprint(g.lead))) ? m : null;
  }

  /**
   * 窗口在 rect 时，它连同贴着它的东西占的地方（框要装下这些）：外框外面的标记和 Usage 条；lead 的侧边栏和停靠的子终端（N2）；
   * 开着的后台 agent 面板和记录窗口（N10）。放大中的窗口就是 rect。
   */
  private withGroup(id: WindowId, rect: Rect): Rect {
    const w = this.windowById(id);
    if (!w || this.isMaximized(w)) return rect;
    const out = this.markOutset(w);
    let ext = out.top || out.bottom ? { ...rect, y: rect.y - out.top, h: rect.h + out.top + out.bottom } : rect;
    const g = this.leadGroup(id);
    if (g) {
      ext = union(ext, sidebarRect(rect));
      const m = this.dockedMember(g);
      if (m) ext = union(ext, { ...m.rect, ...dockSlot(rect) });
    }
    const panel = this.state.backgroundPanels[id];
    if (panel) {
      if (!g) ext = union(ext, sidebarRect(rect));
      if (panel.selected) ext = union(ext, transcriptRect(rect));
    }
    return ext;
  }

  /** 找空位、对齐线不看的窗口：收起的子终端；id 是 lead 时还有停靠在它旁边的子终端（算在 lead 占的地方里）。 */
  private groupSkip(id: WindowId | null): Set<WindowId> {
    const skip = hiddenMembers(this.state.windows);
    const g = id ? this.leadGroup(id) : undefined;
    const m = g ? this.dockedMember(g) : null;
    if (m) skip.add(m.id);
    return skip;
  }

  /** ws 里别的组的侧边栏（id 自己的组的不算），新放的窗口不盖住它们。 */
  private sidebarObstacles(ws: WorkspaceId | null, id: WindowId | null): Rect[] {
    return listGroups(this.state.windows)
      .filter((g) => g.lead.workspaceId === ws && g.lead.id !== id && !g.members.some((m) => m.id === id) && !this.isMaximized(g.lead))
      .map((g) => sidebarRect(g.lead.rect));
  }

  /** 侧边栏、停靠的子终端新出现在那里：框先长到装得下，盖住的别的窗口挪到最近的空位（新出现的东西让出地方）。 */
  private settleGroup(groupId: WindowGroupId): void {
    const g = listGroups(this.state.windows).find((x) => x.id === groupId);
    if (!g || this.isMaximized(g.lead)) return;
    const ws = g.lead.workspaceId;
    const anchor = this.footprint(g.lead);
    this.fitFrameTo(ws, this.withGroup(g.lead.id, anchor));
    const docked = this.dockedMember(g);
    const parts = [anchor, sidebarRect(anchor), ...(docked ? [docked.rect] : [])];
    const inGroup = new Set([g.lead.id, ...g.members.map((m) => m.id)]);
    const parked = hiddenMembers(this.state.windows);
    for (const w of this.state.windows) {
      if (w.workspaceId !== ws || inGroup.has(w.id) || parked.has(w.id) || this.isMaximized(w)) continue;
      if (!parts.slice(1).some((p) => intersects(p, w.rect))) continue;
      const s = this.state;
      const hidden = hiddenMembers(s.windows);
      const others = s.windows.filter((o) => o.id !== w.id && o.workspaceId === ws && !inGroup.has(o.id) && !hidden.has(o.id)).map((o) => this.footprint(o));
      const frame = this.frameOf(ws)?.rect ?? null;
      const r = findFreeSpot(w.rect, [...parts, ...others, ...this.sidebarObstacles(ws, w.id)], { gap: GAP, area: frame ? innerArea(frame) : null });
      this.patchWindow(w.id, { rect: r });
      this.fitFrameTo(ws, r);
    }
  }

  /** board.focus-window（N1 focus_window）：跳过去、闪一下并聚焦；用户正在打字时只闪一下。 */
  focusFromService(target: { windowId: WindowId } | { terminalId: TerminalId }): void {
    const w = 'windowId' in target ? this.windowById(target.windowId) : this.windowOfTerminal(target.terminalId);
    if (!w) return;
    if (this.isUserTyping()) this.flashWindow(w.id);
    else this.jumpAndFlash(w.id);
  }

  /** board.notify（N1 notify）：发通知的窗口闪一下，弹一条“claude · feat/login: Tests passed”；用户正在打字时只闪。 */
  notifyFromService(from: TerminalId | null, message: string): void {
    const w = this.windowOfTerminal(from);
    if (w) this.flashWindow(w.id);
    if (this.isUserTyping()) return;
    const who = w ? `${w.title ?? defaultName(w, this.definitionOf(w)?.label)} · ${this.workspaceTitle(w.workspaceId)}` : 'Agent';
    this.notify(`${who}: ${message}`);
  }

  /** 记一次键盘输入（start() 里接到 window 的 keydown；测试直接调）。 */
  noteKeyboardInput(at: number = Date.now()): void {
    this.lastKeyAt = at;
  }

  /** 最近 TYPING_MS 里按过键。 */
  isUserTyping(at: number = Date.now()): boolean {
    return at - this.lastKeyAt < TYPING_MS;
  }

  private windowOfTerminal(id: TerminalId | null): WindowNode | undefined {
    return id ? this.state.windows.find((w) => terminalIdOf(w) === id) : undefined;
  }

  /** 服务给的工作区不在白板上（没有框）时散放。 */
  private onBoardWorkspace(ws: WorkspaceId | null): WorkspaceId | null {
    return ws && this.frameOf(ws) ? ws : null;
  }

  // ---- 关闭 ----

  /** 关闭窗口：运行中的终端先确认（结束进程，不能撤销）；已退出的终端和其他窗口直接关。 */
  closeWindow(id: WindowId): void {
    const w = this.windowById(id);
    if (!w) return;
    if (isTerminal(w) && terminalIdOf(w)) {
      const st = statusOf(w, this.state.statuses);
      if (!st || !STOPPED.has(st.status)) {
        this.set({ dialog: { kind: 'stop-terminal', windowId: id, topic: null } });
        // 确认里写上当前对话的主题（程序设的终端标题），例如 “Stop claude · Check local git history?”
        const tid = terminalIdOf(w)!;
        void this.api.terminals.list().then(
          (list) => {
            const topic = list.find((t) => t.id === tid)?.title ?? null;
            if (!topic) return;
            this.set((s) => (s.dialog?.kind === 'stop-terminal' && s.dialog.windowId === id ? { dialog: { ...s.dialog, topic } } : {}));
          },
          () => {},
        );
        return;
      }
      void this.api.terminals.kill(terminalIdOf(w)!).catch(() => {});
    }
    this.record('Close window', () => this.removeWindows([id]));
  }

  /** “Stop and close”。 */
  async stopAndClose(id: WindowId): Promise<void> {
    this.set({ dialog: null });
    const w = this.windowById(id);
    if (!w) return;
    const tid = terminalIdOf(w);
    if (tid) await this.api.terminals.kill(tid).catch((e: unknown) => this.notify(errorMessage(e)));
    this.record('Close window', () => this.removeWindows([id]));
  }

  private removeWindows(ids: WindowId[]): void {
    // N2：关掉 lead，子终端变回普通窗口：先照 Show all 平铺开（收起的都显示出来），再拆组
    for (const id of ids) {
      const g = this.leadGroup(id);
      if (g && groupView(g).mode !== 'all') this.tileGroup(g.id);
    }
    const gone = new Set(ids);
    this.set((s) => {
      const badges = { ...s.badges };
      for (const id of ids) delete badges[id];
      return {
        windows: dissolveGroups(s.windows.filter((w) => !gone.has(w.id))),
        badges,
        focusedId: s.focusedId && gone.has(s.focusedId) ? null : s.focusedId,
        selection: s.selection.some((x) => gone.has(x)) ? s.selection.filter((x) => !gone.has(x)) : s.selection,
      };
    });
  }

  /** 工作区没了：框和里面的窗口从白板上拿掉。 */
  private dropWorkspace(ws: WorkspaceId): void {
    const ids = this.windowsIn(ws).map((w) => w.id);
    this.removeWindows(ids);
    this.set((s) => {
      const { [ws]: _, ...workspaces } = s.workspaces;
      return {
        frames: s.frames.filter((f) => f.workspaceId !== ws),
        workspaces,
        selectedFrame: s.selectedFrame === ws ? null : s.selectedFrame,
      };
    });
  }

  // ---- 对话框和菜单 ----

  openDialog(dialog: DialogState): void {
    this.set({ dialog, menu: null });
  }

  closeDialog(): void {
    this.set({ dialog: null });
  }

  openMenu(menu: MenuState): void {
    this.set({ menu });
  }

  closeMenu(): void {
    if (this.state.menu) this.set({ menu: null });
  }

  /** W5 的 Open new：在目标框里新开一个同款 agent，放在松手的位置。 */
  async openInWorkspace(windowId: WindowId, to: WorkspaceId, at: Point | null): Promise<WindowId | null> {
    this.set({ dialog: null });
    const w = this.windowById(windowId);
    if (!w || !isTerminal(w)) return null;
    const data = w.data as TerminalWindowData;
    const frame = this.frameOf(to);
    // 松手的位置不在目标框里（比如框很小）时放进框里
    const pos = at && frame && containsPoint(frame.rect, at) ? at : null;
    const command = (data.agent === 'shell' || data.agent === 'custom') && data.startCommand ? data.startCommand : undefined;
    return this.newTerminal({ agent: data.agent, workspaceId: to, at: pos, ...(command ? { command } : {}) });
  }

  /** W5 提示的那句话。能 Fork 时（X4）一起问。 */
  moveTerminalMessage(windowId: WindowId, to: WorkspaceId): string {
    const w = this.windowById(windowId);
    const agent = w && isTerminal(w) ? (w.data as TerminalWindowData).agent : null;
    const head = `This terminal runs in ${this.workspaceTitle(w?.workspaceId ?? null)} and can’t change folders.`;
    if (this.forkCheckOf(windowId)?.ok) {
      return `${head} Open a new ${agentNoun(agent)} in ${this.workspaceTitle(to)}, or fork this conversation there? The original keeps running.`;
    }
    return `${head} Open a new ${agentNoun(agent)} in ${this.workspaceTitle(to)}?`;
  }

  /** X4：这个终端能不能 Fork、不能时的原因。null：不是 agent 终端，不提供 Fork。 */
  forkCheckOf(windowId: WindowId): ForkCheck | null {
    const w = this.windowById(windowId);
    return w ? forkCheck(w, this.state.agents, this.state.statuses) : null;
  }

  /**
   * X4 · Fork conversation into…（W5 对话框的 Fork、终端标题栏菜单）：在目标框里开一个同款 agent，
   * 带着这个终端的对话（claude --resume <id> --fork-session、codex fork <id>、pi / omp --fork）。原来的终端不动。
   * at 照 Open new：松手的位置在目标框里就放那里，否则按平常的规则放进框里。不能 Fork 时提示原因，不开终端。
   */
  async forkInWorkspace(windowId: WindowId, to: WorkspaceId, at: Point | null): Promise<WindowId | null> {
    this.set({ dialog: null });
    const w = this.windowById(windowId);
    if (!w || !isTerminal(w)) return null;
    const check = forkCheck(w, this.state.agents, this.state.statuses);
    if (!check) return null;
    if (!check.ok) {
      this.notify(check.reason);
      return null;
    }
    const data = w.data as TerminalWindowData;
    const frame = this.frameOf(to);
    const pos = at && frame && containsPoint(frame.rect, at) ? at : null;
    return this.newTerminal({ agent: data.agent, workspaceId: to, at: pos, mode: { kind: 'fork', sessionId: check.sessionId } });
  }

  // ---- 工作区 ----

  /** New workspace…（右键、Projects ▾、⌘⇧N）。at 为 null 时框出现在视口中心。 */
  openNewWorkspace(opts: { projectId?: ProjectId | null; at?: Point | null } = {}): void {
    this.openDialog({ kind: 'new-workspace', projectId: opts.projectId ?? this.state.projects[0]?.id ?? null, at: opts.at ?? null });
  }

  /** 项目的主目录工作区已经在白板上（New workspace 里 Main folder 不可选）。 */
  mainFolderOnBoard(projectId: ProjectId): boolean {
    const s = this.state;
    return s.frames.some((f) => {
      const ws = s.workspaces[f.workspaceId];
      return ws?.projectId === projectId && ws.mode === 'main-folder';
    });
  }

  /** 新工作区框的默认大小：刚好放下一个默认大小的终端。 */
  private defaultFrameSize(): Size {
    const t = this.registry.get(TERMINAL_TYPE)?.defaultSize ?? FALLBACK_SIZE;
    return { w: t.w + FRAME_PAD * 2, h: t.h + FRAME_HEADER + FRAME_PAD };
  }

  /**
   * 没给位置的新框放哪：视口中心空着就放中心（对话框的位置）；和别的框或窗口重叠时放到所有东西的右边，再把视口移过去。
   */
  private freeFrameRect(size: Size): Rect {
    const c = this.viewportCenter();
    const centered = { x: Math.round(c.x - size.w / 2), y: Math.round(c.y - size.h / 2), ...size };
    const s = this.state;
    const taken = [...s.frames.map((f) => f.rect), ...s.windows.map((w) => w.rect), ...s.pending.map((p) => p.rect)];
    if (!taken.some((r) => tooClose(r, centered, GAP))) return centered;
    const all = bounds(taken)!;
    return { x: all.x + all.w + GAP * 3, y: all.y, ...size };
  }

  /** 提交 New workspace 对话框：框先出现（Creating worktree…），建好后换成真的框，有初始化命令就在框里开一个 Shell。 */
  async createWorkspace(req: CreateWorkspaceRequest, at: Point | null, pendingId?: string): Promise<WorkspaceId | null> {
    this.set({ dialog: null });
    const project = this.state.projects.find((p) => p.id === req.projectId);
    const size = this.defaultFrameSize();
    const existing = pendingId ? this.state.pending.find((p) => p.id === pendingId) : undefined;
    const rect = existing?.rect ?? (at ? { x: at.x, y: at.y, ...size } : this.freeFrameRect(size));
    if (!existing && !at && !this.isVisible(rect)) this.centerOn(rect, Math.min(1, Math.max(this.state.viewport.zoom, SUMMARY_ZOOM)));
    const id = existing?.id ?? `pending-${++this.pendingSeq}`;
    const tail = req.mode === 'main-folder' ? 'main folder' : (req.branch?.name ?? '');
    const pending: PendingFrame = {
      id,
      projectId: req.projectId,
      label: project ? `${project.name} · ${tail}` : tail,
      rect,
      message: req.mode === 'main-folder' ? 'Adding…' : 'Creating worktree…',
      error: null,
      request: req,
    };
    this.set((s) => ({ pending: existing ? s.pending.map((p) => (p.id === id ? pending : p)) : [...s.pending, pending] }));

    try {
      const { workspace, setup } = await this.api.workspaces.create(req);
      const placed = this.state.pending.find((p) => p.id === id)?.rect ?? rect;
      this.set((s) => ({
        pending: s.pending.filter((p) => p.id !== id),
        workspaces: { ...s.workspaces, [workspace.id]: workspace },
        frames: [...s.frames.filter((f) => f.workspaceId !== workspace.id), { workspaceId: workspace.id, rect: placed, z: this.maxFrameZ() + 1, autoApprove: false }],
      }));
      if (setup) {
        await this.newTerminal({ agent: 'shell', workspaceId: workspace.id, command: setup.command, cwd: setup.cwd, title: 'setup' });
      }
      return workspace.id;
    } catch (e) {
      const data: AgentDeckErrorData = { code: (errorCode(e) ?? 'internal') as ErrorCode, message: errorMessage(e) };
      this.set((s) => ({ pending: s.pending.map((p) => (p.id === id ? { ...p, error: data } : p)) }));
      return null;
    }
  }

  /** 创建失败的框：Retry（branch-exists 时可以改用已有分支）。 */
  retryPending(id: string, useExistingBranch = false): Promise<WorkspaceId | null> {
    const p = this.state.pending.find((x) => x.id === id);
    if (!p) return Promise.resolve(null);
    const req: CreateWorkspaceRequest =
      useExistingBranch && p.request.branch ? { ...p.request, branch: { kind: 'existing', name: p.request.branch.name } } : p.request;
    return this.createWorkspace(req, null, id);
  }

  dismissPending(id: string): void {
    this.set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
  }

  /** 选中框按 Delete、右键框 › Delete workspace…。 */
  askRemoveWorkspace(ws: WorkspaceId): void {
    if (!this.frameOf(ws)) return;
    this.openDialog({ kind: 'remove-workspace', workspaceId: ws, dirty: false, busy: false, error: null });
  }

  /** 会被结束的终端的名字，例如 ['claude', 'zsh']。 */
  runningTerminalNames(ws: WorkspaceId): string[] {
    const s = this.state;
    return this.windowsIn(ws)
      .filter((w) => {
        if (!isTerminal(w)) return false;
        const st = statusOf(w, s.statuses);
        return !st || !STOPPED.has(st.status);
      })
      .map((w) => w.title ?? defaultName(w, this.definitionOf(w)?.label));
  }

  /**
   * 删除工作区。deleteFolder：同时删掉 worktree 文件夹（分支保留）。有未提交的改动时服务抛 dirty-worktree，
   * 对话框改成要求勾选确认，再带 force 调一次。成功后结束框里的终端，框和窗口从白板拿掉。
   */
  async removeWorkspace(ws: WorkspaceId, deleteFolder: boolean, force = false): Promise<boolean> {
    const label = this.workspaceTitle(ws);
    const terminals = this.windowsIn(ws).map(terminalIdOf).filter((t): t is NonNullable<typeof t> => t !== null);
    this.set((s) => (s.dialog?.kind === 'remove-workspace' ? { dialog: { ...s.dialog, busy: true, error: null } } : {}));
    try {
      await this.api.workspaces.remove({ id: ws, deleteFolder, ...(force ? { force: true } : {}) });
    } catch (e) {
      if (errorCode(e) === 'dirty-worktree' && !force) {
        this.set((s) => (s.dialog?.kind === 'remove-workspace' ? { dialog: { ...s.dialog, busy: false, dirty: true } } : {}));
      } else {
        this.set((s) => (s.dialog?.kind === 'remove-workspace' ? { dialog: { ...s.dialog, busy: false, error: errorMessage(e) } } : {}));
      }
      return false;
    }
    await Promise.all(terminals.map((t) => this.api.terminals.kill(t).catch(() => {})));
    this.dropWorkspace(ws);
    this.set({ dialog: null });
    this.notify(deleteFolder ? `Deleted ${label} and its folder` : `Removed ${label} from the board`);
    return true;
  }

  /** Add project…：选文件夹 → 探测 → 添加，然后直接进新建工作区对话框（验收场景 1）。 */
  async addProject(at: Point | null = null): Promise<ProjectId | null> {
    this.closeMenu();
    let projectId: ProjectId | null;
    try {
      if (this.opts.addProject) {
        projectId = await this.opts.addProject();
      } else {
        const folder = await this.api.app.pickFolder({ title: 'Add project' });
        if (!folder) return null;
        const probe = await this.api.projects.probe(folder);
        if (probe.kind === 'already-added') projectId = probe.project.id;
        else {
          const added = await this.api.projects.add({
            folder: probe.kind === 'git' ? probe.repoRoot : probe.folder,
            as: probe.kind,
          });
          projectId = added[0]?.id ?? null;
        }
      }
    } catch (e) {
      this.notify(errorMessage(e));
      return null;
    }
    if (!projectId) return null;
    await this.refreshProjects();
    this.openNewWorkspace({ projectId, at });
    return projectId;
  }

  // ---- Settings（TC-15） ----

  /**
   * 打开 Settings：顶栏 Settings、⌘,、Projects ▾ › Project settings…、终端窗口里的设置链接。
   * 没指定项目时停在当前项目上（IS-71）：选中的框或聚焦窗口所在工作区的项目（和右侧面板跟随的同一个，`activeWorkspaceId`）；
   * 都没有（或是散放的窗口）时停在第一个项目上。
   */
  openSettings(opts: { section?: SettingsSection; projectId?: ProjectId | null } = {}): void {
    const projectId = opts.projectId ?? this.currentProjectId() ?? this.state.projects[0]?.id ?? null;
    const section = opts.section ?? (projectId ? 'projects' : 'general');
    this.openDialog(section === 'projects' && projectId ? { kind: 'settings', section, projectId } : { kind: 'settings', section: 'general' });
  }

  /** 选中的框或聚焦窗口所在工作区的项目；项目已经不在列表里时为 null。 */
  private currentProjectId(): ProjectId | null {
    const ws = this.activeWorkspaceId();
    const projectId = ws ? this.state.workspaces[ws]?.projectId : undefined;
    return projectId && this.state.projects.some((p) => p.id === projectId) ? projectId : null;
  }

  /** 保存一个项目的设置（projects.update）。失败时提示，返回 false。 */
  async saveProjectSettings(id: ProjectId, patch: ProjectPatch): Promise<boolean> {
    try {
      const project = await this.api.projects.update(id, patch);
      this.set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
      return true;
    } catch (e) {
      this.notify(`Couldn’t save ${this.state.projects.find((p) => p.id === id)?.name ?? 'the project'}: ${errorMessage(e)}`);
      return false;
    }
  }

  /** 保存 General 页（app.updateSettings）。失败时提示，返回 false。 */
  async saveAppSettings(patch: Partial<Settings>): Promise<boolean> {
    try {
      await this.api.app.updateSettings(patch);
      return true;
    } catch (e) {
      this.notify(`Couldn’t save settings: ${errorMessage(e)}`);
      return false;
    }
  }

  /** 项目文件夹找不到时 Locate…：选新的位置，projects.locate。 */
  async locateProject(id: ProjectId): Promise<boolean> {
    const project = this.state.projects.find((p) => p.id === id);
    try {
      const folder = await this.api.app.pickFolder({ title: `Locate ${project?.name ?? 'project'}` });
      if (!folder) return false;
      const located = await this.api.projects.locate(id, folder);
      this.set((s) => ({ projects: s.projects.map((p) => (p.id === id ? located : p)) }));
      return true;
    } catch (e) {
      this.notify(errorMessage(e));
      return false;
    }
  }

  // ---- 多选和一起拖动（X10） ----

  /** 换掉多选。收起的子终端、已经关掉的窗口不算。 */
  setSelection(ids: readonly WindowId[]): void {
    const s = this.state;
    const hidden = hiddenMembers(s.windows);
    const exists = new Set(s.windows.map((w) => w.id));
    const next = [...new Set(ids)].filter((id) => exists.has(id) && !hidden.has(id));
    const cur = s.selection;
    if (next.length === cur.length && next.every((x, i) => x === cur[i])) return;
    this.set({ selection: next });
  }

  clearSelection(): void {
    if (this.state.selection.length > 0) this.set({ selection: [] });
  }

  /** ⌘ / Shift + 单击标题栏：选上或去掉这个窗口。 */
  toggleSelected(id: WindowId): void {
    this.setSelection(toggleSelection(this.state.selection, id, this.state.focusedId));
  }

  isSelected(id: WindowId): boolean {
    return this.state.selection.includes(id);
  }

  /**
   * 框选开始（Shift + 左键在空白处按下，白板坐标）。additive（同时按着 ⌘）时加在已经选中的上面。
   * 取消聚焦的窗口和选中的框：框选完焦点在白板上，Esc 取消选择、⌘Z 撤销白板。
   */
  boxSelectStart(p: Point, additive = false): void {
    this.boxBase = { start: p, base: additive ? this.state.selection : [], additive };
    this.set({
      selectionBox: { x: p.x, y: p.y, w: 0, h: 0 },
      menu: null,
      focusedId: null,
      selectedFrame: null,
      ...(additive ? {} : { selection: [] }),
    });
  }

  boxSelectMove(p: Point): void {
    const b = this.boxBase;
    if (!b) return;
    const box = boxFrom(b.start, p);
    const hit = windowsInBox(box, this.state.windows, hiddenMembers(this.state.windows));
    this.set({ selectionBox: box });
    this.setSelection(boxSelection(b.base, hit, b.additive));
  }

  boxSelectEnd(): void {
    if (!this.boxBase) return;
    this.boxBase = null;
    this.set({ selectionBox: null });
  }

  /** 拖 id 时一起动的窗口：id 在多选里（且不只它一个）时是选中的那些（没收起、没放大），否则空。 */
  private movableSelection(id: WindowId): WindowNode[] {
    const s = this.state;
    if (!s.selection.includes(id)) return [];
    const self = this.windowById(id);
    if (!self || this.isMaximized(self)) return [];
    const hidden = hiddenMembers(s.windows);
    const set = new Set(s.selection);
    return s.windows.filter((w) => set.has(w.id) && !hidden.has(w.id) && !this.isMaximized(w));
  }

  /** 找空位、对齐线不看的：收起的子终端，和选中的 lead 停靠在旁边的子终端（跟着 lead 走）。 */
  private selectionSkip(ids: readonly WindowId[]): Set<WindowId> {
    const skip = hiddenMembers(this.state.windows);
    for (const id of ids) for (const x of this.groupSkip(id)) skip.add(x);
    return skip;
  }

  /** ws 里的选中窗口放在 rects 时占的地方（连同 lead 的侧边栏、停靠的子终端、用量条）。 */
  private blockOf(ws: WorkspaceId | null, rects: ReadonlyMap<WindowId, Rect>): Rect | null {
    const parts: Rect[] = [];
    for (const [id, r] of rects) {
      const w = this.windowById(id);
      if (!w || w.workspaceId !== ws) continue;
      parts.push(union(this.withGroup(id, r), this.obstacleRect(w, r)));
    }
    return bounds(parts);
  }

  /** 一起拖动：所有选中的同一个位移；snap 时外接矩形吸到它们所在框里别的窗口（只在一个框里时还有框的内边）和附近的框。 */
  private moveGroup(d: Extract<DragSession, { kind: 'move-group' }>, dx: number, dy: number, opts: DragOptions): void {
    let box = translate(d.bbox, dx, dy);
    let guides: Guide[] = [];
    const moving = new Set(d.ids);
    const wss = [...new Set(d.ids.map((i) => this.windowById(i)?.workspaceId ?? null))];
    if (opts.snap) {
      const s = this.state;
      const only = wss.length === 1 ? wss[0]! : null;
      const area = only ? (d.frameStarts.get(only) ?? null) : null;
      const skip = this.selectionSkip(d.ids);
      const targets = s.windows
        .filter((w) => !moving.has(w.id) && !skip.has(w.id) && wss.includes(w.workspaceId) && (w.workspaceId !== null || this.isVisible(w.rect, s)))
        .map((w) => this.footprint(w));
      const res = snapMove(box, targets, {
        threshold: this.snapThreshold(),
        gap: GAP,
        area: area ? innerArea(area) : null,
        alignTo: this.nearbyFrames(area ? union(area, box) : box, wss),
      });
      box = res.rect;
      guides = res.guides;
    }
    const mx = box.x - d.bbox.x;
    const my = box.y - d.bbox.y;
    const rects = new Map([...d.starts].map(([id, r]) => [id, translate(r, mx, my)]));
    // 每个框按自己那一批长（只变大，松手时再挤开别的框）
    const frameRects = new Map<WorkspaceId, Rect>();
    for (const [ws, start] of d.frameStarts) {
      const block = this.blockOf(ws, rects);
      frameRects.set(ws, block ? growFrame(start, block) : start);
    }
    d.frameLast = frameRects;
    this.set((s) => ({
      guides,
      windows: s.windows.map((w) => {
        const r = rects.get(w.id);
        return r ? { ...w, rect: r } : w;
      }),
      frames: s.frames.map((f) => {
        const r = frameRects.get(f.workspaceId);
        return r && !sameRect(r, f.rect) ? { ...f, rect: r } : f;
      }),
    }));
  }

  /**
   * 一起拖动松手（V3）：每个框里的那一批算一块，盖住别的窗口就整块挪到最近的空位（优先在框里）；
   * 然后每个框按挪好的位置重新长，挤到的框挪开。
   */
  private moveGroupEnd(d: Extract<DragSession, { kind: 'move-group' }>): void {
    const moving = new Set(d.ids);
    const skip = this.selectionSkip(d.ids);
    for (const [ws, list] of byWorkspace(this.state.windows, d.ids)) {
      const rects = new Map(list.map((w) => [w.id, w.rect]));
      const block = this.blockOf(ws, rects);
      if (!block) continue;
      const frameStart = ws ? (d.frameStarts.get(ws) ?? null) : null;
      const s = this.state;
      const obstacles = [
        ...s.windows.filter((w) => w.workspaceId === ws && !moving.has(w.id) && !skip.has(w.id)).map((w) => this.obstacleRect(w)),
        ...listGroups(s.windows)
          .filter((g) => g.lead.workspaceId === ws && !moving.has(g.lead.id) && !this.isMaximized(g.lead))
          .map((g) => sidebarRect(g.lead.rect)),
      ];
      const spot = findFreeSpot(block, obstacles, { gap: GAP, area: frameStart ? innerArea(growFrame(frameStart, block)) : null });
      const mx = spot.x - block.x;
      const my = spot.y - block.y;
      if (mx !== 0 || my !== 0) {
        this.set((st) => ({ windows: st.windows.map((w) => (rects.has(w.id) ? { ...w, rect: translate(w.rect, mx, my) } : w)) }));
      }
    }
    for (const [ws, start] of d.frameStarts) {
      const cur = this.frameOf(ws);
      if (!cur) continue;
      // 前面一个框长大时把这个框挤开过：起点跟着挪
      const last = d.frameLast.get(ws) ?? start;
      const from = translate(start, cur.rect.x - last.x, cur.rect.y - last.y);
      const rects = new Map(this.state.windows.filter((w) => moving.has(w.id) && w.workspaceId === ws).map((w) => [w.id, w.rect]));
      const block = this.blockOf(ws, rects);
      this.applyFrameChange(this.layoutBase(), ws, from, block ? growFrame(from, block) : from);
    }
  }

  // ---- 撤销 / 重做（X10） ----

  private layout(): BoardLayout {
    const s = this.state;
    return { frames: s.frames, windows: s.windows };
  }

  /** 拖动松手：按下时到现在改了的算一步。 */
  private finishDrag(label: string): void {
    const base = this.dragBase;
    this.dragBase = null;
    if (base) this.commit(base, label);
  }

  private commit(base: BoardLayout, label: string): void {
    const step = diffLayout(base, this.layout(), label);
    if (step) this.history.push(step);
  }

  /** 做 fn，它改了的白板算一步。嵌套时只在最外层记；拖动中不单独记（松手时算进拖动那一步）。 */
  private record<T>(label: string, fn: () => T): T {
    if (this.recordDepth++ === 0) this.recordBase = this.layout();
    try {
      return fn();
    } finally {
      if (--this.recordDepth === 0) {
        const base = this.recordBase;
        this.recordBase = null;
        if (base && !this.dragBase) this.commit(base, label);
      }
    }
  }

  /** ⌘Z：撤销白板上的上一步。没有可撤销的、正在拖动时返回 false。 */
  undo(): boolean {
    return this.replay('undo');
  }

  /** ⌘⇧Z：重做。 */
  redo(): boolean {
    return this.replay('redo');
  }

  private replay(dir: Direction): boolean {
    if (this.drag || this.boxBase) return false;
    for (;;) {
      const step = this.history.take(dir);
      if (!step) return false;
      if (dir === 'redo' && this.restartedSince(step)) {
        // 撤销关闭后终端重启过：重做会把正在跑的终端从白板上拿掉，不替用户做
        this.history.putBack(dir, step);
        this.notify('Can’t redo: the terminal was restarted. Close it instead.');
        return false;
      }
      const res = applyStep(this.layout(), step, dir);
      // 这一步碰到的东西都不在了（工作区删掉了）：丢掉，接着下一步
      if (!res.changed) continue;
      const removed = new Set(res.removed.map((w) => w.id));
      this.set((s) => {
        let badges = s.badges;
        if (removed.size > 0) {
          badges = { ...s.badges };
          for (const id of removed) delete badges[id];
        }
        return {
          frames: res.frames,
          windows: res.windows,
          badges,
          focusedId: s.focusedId && removed.has(s.focusedId) ? null : s.focusedId,
          selection: removed.size > 0 ? s.selection.filter((x) => !removed.has(x)) : s.selection,
        };
      });
      if (step.name) void this.renameTo(step.name.ws, dir === 'undo' ? step.name.before : step.name.after);
      // 撤销关闭：放回来的窗口闪一下（终端窗口自己按 terminalId 接回，进程没了显示 Previous session ended）
      for (const w of res.restored) this.flashWindow(w.id);
      this.history.done(dir, step);
      return true;
    }
  }

  /** 重做“关闭”时，那个终端窗口现在接的是另一个终端（撤销后点了 Restart）。 */
  private restartedSince(step: HistoryStep): boolean {
    return step.windows.some((ch) => {
      if (ch.after) return false;
      const w = this.windowById(ch.id);
      const now = w ? terminalIdOf(w) : null;
      return now !== null && now !== terminalIdOf(ch.before);
    });
  }

  private async renameTo(ws: WorkspaceId, name: string): Promise<void> {
    try {
      const updated = await this.api.workspaces.rename(ws, name);
      this.set((s) => ({ workspaces: { ...s.workspaces, [ws]: updated } }));
    } catch (e) {
      this.notify(errorMessage(e));
    }
  }

  // ---- 快捷键 ----

  /** 默认 agent（Settings 里的 defaultAgent），取不到时用第一个装好的。 */
  async defaultAgent(): Promise<AgentKind> {
    const settings = await this.api.app.getSettings().catch(() => null);
    const installed = startableAgents(this.state.agents);
    if (settings && installed.some((a) => a.id === settings.defaultAgent)) return settings.defaultAgent;
    return installed[0]?.id ?? 'shell';
  }

  /** 执行一个快捷键。返回 false 表示这次不处理（按键照常交给页面）。 */
  runShortcut(id: ShortcutId): boolean {
    const s = this.state;
    const focused = s.focusedId ? this.windowById(s.focusedId) : undefined;
    switch (id) {
      case 'new-terminal':
        void this.defaultAgent().then((agent) =>
          this.newTerminal({ agent, workspaceId: focused?.workspaceId ?? null, nextTo: focused?.id ?? null }),
        );
        return true;
      case 'new-browser':
        this.newBrowser({ workspaceId: focused?.workspaceId ?? null, nextTo: focused?.id ?? null });
        return true;
      case 'new-workspace':
        this.openNewWorkspace();
        return true;
      case 'close-window':
        if (!focused) return false;
        this.closeWindow(focused.id);
        return true;
      case 'toggle-maximize':
        if (!focused) return false;
        this.toggleMaximize(focused.id);
        return true;
      case 'next-waiting':
        this.jumpToNextWaiting();
        return true;
      case 'prev-waiting':
        this.jumpToPrevWaiting();
        return true;
      case 'next-window':
        this.jumpToAdjacentWindow(1);
        return true;
      case 'prev-window':
        this.jumpToAdjacentWindow(-1);
        return true;
      case 'toggle-panel':
        this.togglePanel();
        return true;
      case 'zoom-100':
        this.zoomTo(1);
        return true;
      case 'show-all':
        this.showAll();
        return true;
      case 'zoom-in':
        this.zoomBy(1.25);
        return true;
      case 'zoom-out':
        this.zoomBy(0.8);
        return true;
      case 'clear-terminal':
        // 由聚焦的窗口自己处理（见 Board 里的 agentdeck:window-command 事件）
        return !!focused;
      case 'delete-selection':
        if (!s.selectedFrame) return false;
        this.askRemoveWorkspace(s.selectedFrame);
        return true;
      case 'open-settings':
        this.openSettings();
        return true;
      case 'escape':
        if (s.menu) this.closeMenu();
        else {
          this.focusWindow(null);
          this.clearSelection();
        }
        return true;
      case 'undo':
        this.undo();
        return true;
      case 'redo':
        this.redo();
        return true;
    }
  }
}

