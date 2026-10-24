// BoardController：白板的全部行为。React 组件只负责画和把手势交给它；它只通过 window.agentdeck（AgentDeckApi）调服务。
// 不依赖 React，测试里直接拿 createFakeApi() 跑。

import type { AgentDeckApi, AgentDeckErrorData, AgentKind, BoardState, CreateWorkspaceRequest, ErrorCode, FrameNode, OpenWindowRequest, ProjectId, ProjectPatch, Rect, Settings, Size, TerminalId, TerminalWindowData, Unsubscribe, Viewport, WindowCommand, WindowGroupId, WindowGroupMemberRequest, WindowId, WindowNode, WindowStatusBadge, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { TITLE_BAR_HEIGHT, resizeRect, type ResizeEdge } from '@agentdeck/ui-window-shell';
import { isSummarySize, windowRegistry, type WindowDefinition, type WindowRegistry } from './registry.ts';
import { ApprovalsModel } from './approvals/model.ts';
import { startableAgents } from './model/agents.ts';
import { nextWaiting, prevWaiting, summarize, statusOf, type AttentionSummary } from './model/attention.ts';
import { createAutosave, type Autosave } from './model/autosave.ts';
import { GAP, clampFrameMove, findFreeSpot, inflate, pushFrames, separateFrames, tooClose } from './model/avoid.ts';
import { decideDrop, dropTargetAt } from './model/drop.ts';
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
import { dissolveGroups } from './model/groups.ts';
import { adjacentWindow, windowOrder } from './model/navigation.ts';
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
    this.store.setState(patch);
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
    );
    // 用户在哪儿打字（终端的 xterm、对话框的输入框……）都会经过 window 的 keydown（捕获阶段）。网页窗口的 iframe 里的按键收不到。
    if (typeof window !== 'undefined') {
      const onKey = () => this.noteKeyboardInput();
      window.addEventListener('keydown', onKey, true);
      this.unsubs.push(() => window.removeEventListener('keydown', onKey, true));
    }
    void this.approvals.start();
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

  private contentBounds(ws: WorkspaceId): Rect | null {
    return bounds(this.windowsIn(ws).map((w) => w.rect));
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

  /** 对齐线看的窗口：同一个框里别的窗口；散放的窗口看视口里别的散放窗口。 */
  private snapTargets(id: WindowId, ws: WorkspaceId | null): Rect[] {
    const s = this.state;
    return s.windows
      .filter((w) => w.id !== id && w.workspaceId === ws && (ws !== null || this.isVisible(w.rect, s)))
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
    const obstacles = this.state.windows.filter((w) => w.id !== id && w.workspaceId === ws).map((w) => this.footprint(w));
    return findFreeSpot(rect, obstacles, { gap: GAP, area: frameRect ? innerArea(growFrame(frameRect, rect)) : null });
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
    this.patchWindow(id, { title: title.trim() || null });
  }

  async renameWorkspace(ws: WorkspaceId, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const updated = await this.api.workspaces.rename(ws, trimmed);
      this.set((s) => ({ workspaces: { ...s.workspaces, [ws]: updated } }));
    } catch (e) {
      this.notify(errorMessage(e));
    }
  }

  // ---- 拖动：窗口 ----

  moveWindowStart(id: WindowId): void {
    const w = this.windowById(id);
    if (!w) return;
    this.drag = { kind: 'move-window', id, start: w.rect, frameStart: this.frameOf(w.workspaceId)?.rect ?? null };
    this.set({ lifted: id });
  }

  /**
   * dx、dy：白板坐标的总位移；pointer：指针的白板坐标。snap 时吸到同一个框里别的窗口和框的内边（指针进了别的框就看那个框），
   * 还有附近的框的外边和中线（IS-65），画对齐线。重叠不在这里管，松手时再挪。
   */
  moveWindow(id: WindowId, dx: number, dy: number, pointer: Point, opts: DragOptions = {}): void {
    const d = this.drag;
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
          ? s.frames.map((f) => (f.workspaceId === w.workspaceId ? { ...f, rect: target ? d.frameStart! : growFrame(d.frameStart!, rect) } : f))
          : s.frames,
    }));
  }

  moveWindowEnd(id: WindowId): void {
    const d = this.drag;
    this.drag = null;
    const target = this.state.dropTarget;
    this.set({ lifted: null, dropTarget: null, guides: [] });
    if (d?.kind !== 'move-window' || d.id !== id) return;
    const w = this.windowById(id);
    if (!w) return;
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
      if (w.workspaceId && d.frameStart) this.applyFrameChange(this.layoutBase(), w.workspaceId, d.frameStart, growFrame(d.frameStart, rect));
    }
  }

  resizeWindowStart(id: WindowId, edge: ResizeEdge): void {
    const w = this.windowById(id);
    if (!w) return;
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
    if (d.frameStart && w.workspaceId) this.applyFrameChange(d.base, w.workspaceId, d.frameStart, growFrame(d.frameStart, rect));
  }

  /** 松手才把新大小写进窗口，组件这时才拿到新的 contentSize。 */
  resizeWindowEnd(id: WindowId): void {
    const d = this.drag;
    const live = this.state.resizing;
    this.drag = null;
    this.set({ resizing: null, guides: [] });
    if (d?.kind !== 'resize-window' || d.id !== id || !live) return;
    const w = this.windowById(id);
    if (!w) return;
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
    if (d.frameStart && w.workspaceId) this.applyFrameChange(d.base, w.workspaceId, d.frameStart, growFrame(d.frameStart, rect));
  }

  /** 单击摘要卡：拉小的恢复原来的大小；因为白板缩得太小的，缩放到 100% 看它。都会聚焦。 */
  expandSummary(id: WindowId): void {
    const w = this.windowById(id);
    if (!w) return;
    const def = this.definitionOf(w);
    if (def && isSummarySize(def, w.rect) && w.restoreRect) {
      const rect = { ...w.rect, w: w.restoreRect.w, h: w.restoreRect.h };
      this.patchWindow(id, { rect, restoreRect: null });
      this.fitFrameTo(w.workspaceId, rect);
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
      this.patchWindow(id, { rect: back, restoreRect: null });
      this.focusWindow(id);
      // 还原后窗口回到原来的位置（不挪出它的框），视口平移过去让它停在屏幕中间；不然视口还停在放大时的左上角
      const { pane, viewport } = this.state;
      const zoom = viewport.zoom;
      this.setViewport({ x: pane.w / 2 - (back.x + back.w / 2) * zoom, y: pane.h / 2 - (back.y + back.h / 2) * zoom, zoom }, 200);
      return;
    }
    const { pane } = this.state;
    const rect = {
      x: w.rect.x,
      y: w.rect.y,
      w: Math.max(w.rect.w, pane.w - MAXIMIZE_MARGIN * 2),
      h: Math.max(w.rect.h, pane.h - MAXIMIZE_MARGIN * 2),
    };
    this.patchWindow(id, { rect, restoreRect: w.rect });
    this.focusWindow(id);
    this.setViewport({ x: -rect.x + MAXIMIZE_MARGIN, y: -rect.y + MAXIMIZE_MARGIN, zoom: 1 }, 200);
  }

  // ---- 拖动：框 ----

  /** 拖框的标题栏：框和里面的窗口一起动。 */
  moveFrameStart(ws: WorkspaceId): void {
    const f = this.frameOf(ws);
    if (!f) return;
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
  }

  resizeFrameStart(ws: WorkspaceId, edge: ResizeEdge): void {
    const f = this.frameOf(ws);
    if (!f) return;
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
  addWindow<TData>(init: { type: string; workspaceId: WorkspaceId | null; rect: Rect; data: TData; title?: string | null }): WindowId {
    const id = newWindowId();
    // V3：放的位置盖住了别的窗口就挪到最近的空位
    const rect = this.freeSpotFor(null, init.workspaceId, init.rect, this.frameOf(init.workspaceId)?.rect ?? null);
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
    this.fitFrameTo(init.workspaceId, rect);
    this.focusWindow(id);
    return id;
  }

  /** 新建终端（New terminal ▸、⌘N、框里的初始化命令、W5 的 Open new）。框里的目录是工作区目录，散放时是主目录。 */
  async newTerminal(opts: {
    agent: AgentKind;
    workspaceId: WorkspaceId | null;
    at?: Point | null;
    nextTo?: WindowId | null;
    /** Shell 或自定义命令要运行的命令。 */
    command?: string;
    cwd?: string;
    title?: string | null;
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
        mode: { kind: 'new' },
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
  openWindow(fromId: WindowId | null, req: OpenWindowRequest, opts: { quiet?: boolean } = {}): WindowId | null {
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
    const id = this.addWindow({ type: req.type, workspaceId: ws, rect, data: def.create(req.data as never) });
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
    const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    const ids: WindowId[] = [];
    members.forEach((m, i) => {
      const workspaceId = this.onBoardWorkspace(m.request.workspaceId ?? null);
      const beside = leadWin && leadWin.workspaceId === workspaceId ? leadWin : null;
      let rect = m.request.rect;
      if (beside && !rect) {
        const size = this.registry.get(m.request.type)?.defaultSize ?? FALLBACK_SIZE;
        const col = i % cols;
        const row = Math.floor(i / cols);
        rect = {
          x: beside.rect.x + beside.rect.w + GAP + col * (size.w + GAP),
          y: beside.rect.y + row * (size.h + GAP),
        };
      }
      const id = this.openWindow(null, { ...m.request, workspaceId, ...(rect ? { rect } : {}) }, { quiet: true });
      if (!id) return;
      ids.push(id);
      if (highlight) this.flashWindow(id);
    });
    if (leadWin && ids.length > 0) {
      const current = this.windowById(leadWin.id)?.group;
      const groupId = current?.id ?? newGroupId();
      const labels = new Map(ids.map((id, i) => [id, members[i]?.label ?? null]));
      this.set((s) => ({
        windows: s.windows.map((w) => {
          if (w.id === leadWin.id && !current) return { ...w, group: { id: groupId, role: 'lead', label: null } };
          if (labels.has(w.id)) return { ...w, group: { id: groupId, role: 'member', label: labels.get(w.id) ?? null } };
          return w;
        }),
      }));
    }
    return ids;
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
    this.removeWindows([id]);
  }

  /** “Stop and close”。 */
  async stopAndClose(id: WindowId): Promise<void> {
    this.set({ dialog: null });
    const w = this.windowById(id);
    if (!w) return;
    const tid = terminalIdOf(w);
    if (tid) await this.api.terminals.kill(tid).catch((e: unknown) => this.notify(errorMessage(e)));
    this.removeWindows([id]);
  }

  private removeWindows(ids: WindowId[]): void {
    const gone = new Set(ids);
    this.set((s) => {
      const badges = { ...s.badges };
      for (const id of ids) delete badges[id];
      return {
        windows: dissolveGroups(s.windows.filter((w) => !gone.has(w.id))),
        badges,
        focusedId: s.focusedId && gone.has(s.focusedId) ? null : s.focusedId,
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

  /** W5 提示的那句话。 */
  moveTerminalMessage(windowId: WindowId, to: WorkspaceId): string {
    const w = this.windowById(windowId);
    const agent = w && isTerminal(w) ? (w.data as TerminalWindowData).agent : null;
    return `This terminal runs in ${this.workspaceTitle(w?.workspaceId ?? null)} and can’t change folders. Open a new ${agentNoun(agent)} in ${this.workspaceTitle(to)}?`;
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

  /** 打开 Settings：顶栏 Settings、⌘,、Projects ▾ › Project settings…、终端窗口里的设置链接。默认停在第一个项目上。 */
  openSettings(opts: { section?: SettingsSection; projectId?: ProjectId | null } = {}): void {
    const projectId = opts.projectId ?? this.state.projects[0]?.id ?? null;
    const section = opts.section ?? (projectId ? 'projects' : 'general');
    this.openDialog(section === 'projects' && projectId ? { kind: 'settings', section, projectId } : { kind: 'settings', section: 'general' });
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
        else this.focusWindow(null);
        return true;
    }
  }
}

