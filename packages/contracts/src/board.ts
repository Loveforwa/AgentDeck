// 白板的数据形状和保存。需求见「3 · 白板」「9 · 保存与重启」。
// 保存实现：packages/store（M0），运行在主进程，SQLite。白板界面：packages/ui/canvas（线 2）。

import type { AgentKind, AgentSessionId, IsoTime, Rect, Size, TerminalId, WindowId, WorkspaceId } from './common.ts';

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
