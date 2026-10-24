// 白板的状态。保存的部分就是 contracts 的 BoardState（去掉 version、savedAt），其余是界面临时状态。
// 用 zustand 的 vanilla store：BoardController 改它，React 组件按需订阅。

import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  AgentDeckErrorData,
  AgentInfo,
  BoardState,
  CreateWorkspaceRequest,
  Project,
  ProjectId,
  Rect,
  Size,
  StatusSnapshot,
  WindowId,
  WindowStatusBadge,
  Workspace,
  WorkspaceId,
} from '@agentdeck/contracts';
import type { Point } from './model/geometry.ts';
import type { Guide } from './model/snap.ts';

/** 正在创建的工作区：框先出现，后台建 worktree（需求「4 · 工作区框 · 新建工作区」）。 */
export interface PendingFrame {
  id: string;
  projectId: ProjectId;
  /** “agentdeck · feat/oauth” */
  label: string;
  rect: Rect;
  /** “Creating worktree…”，跟着 workspace.progress 变。 */
  message: string;
  error: AgentDeckErrorData | null;
  request: CreateWorkspaceRequest;
}

export type DialogState =
  | { kind: 'new-workspace'; projectId: ProjectId | null; at: Point | null; draft?: Partial<CreateWorkspaceRequest> }
  | { kind: 'remove-workspace'; workspaceId: WorkspaceId; dirty: boolean; busy: boolean; error: string | null }
  /** W5：终端不能换框，问要不要在目标框里新开一个。at 是松手时窗口的位置。 */
  | { kind: 'move-terminal'; windowId: WindowId; to: WorkspaceId; at: Point }
  /**
   * 关闭运行中的终端前确认。画在那个窗口里面（不盖住整个应用）。topic 是程序设的终端标题（当前对话的主题，
   * TerminalInfo.title），打开后异步取到再填上；没有时为 null。
   */
  | { kind: 'stop-terminal'; windowId: WindowId; topic: string | null }
  | { kind: 'rename-window'; windowId: WindowId }
  | { kind: 'rename-workspace'; workspaceId: WorkspaceId }
  /** Settings（TC-15）：左边项目列表和 General，右边那一页。section 为 projects 时 projectId 是选中的项目。 */
  | { kind: 'settings'; section: SettingsSection; projectId?: ProjectId };

/** Settings 的页面。Agents、Approvals 以后再加。 */
export type SettingsSection = 'projects' | 'general';

export type MenuTarget =
  | { kind: 'pane' }
  /** 框里的空白处：和白板的右键菜单相同，但新建的东西放进这个框。 */
  | { kind: 'frame-body'; workspaceId: WorkspaceId }
  | { kind: 'frame-title'; workspaceId: WorkspaceId }
  | { kind: 'window'; windowId: WindowId };

export interface MenuState {
  /** 屏幕坐标，菜单放在这里。 */
  screen: Point;
  /** 白板坐标，新建的东西放在这里。 */
  flow: Point;
  target: MenuTarget;
}

export type SavedBoard = Pick<BoardState, 'viewport' | 'frames' | 'windows' | 'panel'>;

export interface BoardStoreState extends SavedBoard {
  /** board.load() 完成之前为 false，不保存、不显示空白状态。 */
  loaded: boolean;
  focusedId: WindowId | null;
  /** 单击框的标题栏选中它：右侧面板切到这个工作区，Delete 删除它。 */
  selectedFrame: WorkspaceId | null;
  /** 组件用 setStatus 给的状态文字，不保存。 */
  badges: Record<string, WindowStatusBadge>;
  /** 按 terminalId。 */
  statuses: Record<string, StatusSnapshot>;
  workspaces: Record<string, Workspace>;
  /** 最近用过的在前。 */
  projects: Project[];
  agents: AgentInfo[];
  /** 正在拖边改大小的窗口和它现在的外框。松手前组件拿到的 contentSize 不变。 */
  resizing: { id: WindowId; rect: Rect } | null;
  /** 正在被拖动的窗口（浮起来的阴影）。 */
  lifted: WindowId | null;
  /** 拖动中指针所在的别的框。 */
  dropTarget: WorkspaceId | null;
  /** 拖动、改大小时的对齐线（V3），白板坐标。松手清空。 */
  guides: Guide[];
  pending: PendingFrame[];
  dialog: DialogState | null;
  menu: MenuState | null;
  /** 再次打开已有窗口时闪一下边框：值变了就闪。 */
  flash: Record<string, number>;
  /** 白板区域的像素大小。 */
  pane: Size;
}

export function initialState(): BoardStoreState {
  return {
    viewport: { x: 0, y: 0, zoom: 1 },
    frames: [],
    windows: [],
    panel: { open: true, width: 320 },
    loaded: false,
    focusedId: null,
    selectedFrame: null,
    badges: {},
    statuses: {},
    workspaces: {},
    projects: [],
    agents: [],
    resizing: null,
    lifted: null,
    dropTarget: null,
    guides: [],
    pending: [],
    dialog: null,
    menu: null,
    flash: {},
    pane: { w: 1200, h: 800 },
  };
}

export type BoardStore = StoreApi<BoardStoreState>;

export function createBoardStore(init: Partial<BoardStoreState> = {}): BoardStore {
  return createStore<BoardStoreState>()(() => ({ ...initialState(), ...init }));
}

/** 要保存的那部分。引用没变就是没改。 */
export function savedPart(s: BoardStoreState): SavedBoard {
  return { viewport: s.viewport, frames: s.frames, windows: s.windows, panel: s.panel };
}

export function savedPartChanged(a: BoardStoreState, b: BoardStoreState): boolean {
  return a.viewport !== b.viewport || a.frames !== b.frames || a.windows !== b.windows || a.panel !== b.panel;
}
