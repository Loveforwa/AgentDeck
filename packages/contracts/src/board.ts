// 白板的数据形状和保存。需求见「3 · 白板」「9 · 保存与重启」。
// 保存实现：packages/store（M0），运行在主进程，SQLite。白板界面：packages/ui/canvas（线 2）。

import type { AgentKind, AgentSessionId, IsoTime, Rect, Size, TerminalId, WindowId, WorkspaceId } from './common.ts';
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
  /** 放大前的位置，还原时用。 */
  restoreRect: Rect | null;
  data: TData;
}

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
}

export interface BrowserWindowData {
  url: string;
  /** frame：iframe，能跟白板一起缩放；webview：需要登录的页面用（P1）。 */
  mode: 'frame' | 'webview';
}

export interface BoardState {
  version: 1;
  viewport: Viewport;
  frames: FrameNode[];
  windows: WindowNode[];
  panel: { open: boolean; width: number };
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
  /** 同类型、同 key 的窗口已经开着时聚焦它而不是新开，例如网页窗口用 URL 的 origin。 */
  reuseKey?: string;
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
}

export interface WindowStatusBadge {
  text: string;
  /** 'attention' 只用于需要你处理。 */
  tone: 'default' | 'muted' | 'attention' | 'error';
  dot: 'filled' | 'hollow' | 'none';
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
}
