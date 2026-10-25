// 应用壳自己用的几条 IPC（不在 contracts 里，只有 apps/desktop 的 preload 和界面用）：
// 启动信息（登录 shell 环境读失败、tmux 起不来、演示 / 截图模式）、菜单快捷键、截图模式的“白板好了”、打开设置文件。
// 页面里是 window.agentdeckDesktop；另有 window.agentdeckFiles（拖进来的文件换成路径，终端窗口用）。

import type { AgentDeckErrorData } from '@agentdeck/contracts';

/** 菜单里的白板快捷键，和 packages/ui/canvas 的 ShortcutId 一致（Delete、Esc 不进菜单）。 */
export type MenuShortcutId =
  | 'new-terminal'
  | 'new-browser'
  | 'new-workspace'
  | 'close-window'
  | 'toggle-maximize'
  | 'next-waiting'
  | 'prev-waiting'
  | 'next-window'
  | 'prev-window'
  | 'toggle-panel'
  | 'zoom-100'
  | 'show-all'
  | 'zoom-in'
  | 'zoom-out'
  | 'clear-terminal'
  | 'open-settings'
  /** X10：Edit › Undo / Redo。焦点在白板（或终端）上时撤销白板上的操作，在输入框、网页里时照系统的撤销（nativeEdit）。 */
  | 'undo'
  | 'redo';

export const DESKTOP_IPC = {
  startup: 'agentdeck-desktop:startup',
  retryTmux: 'agentdeck-desktop:retry-tmux',
  openSettings: 'agentdeck-desktop:open-settings',
  /** 主进程 → 界面：一句提示（例如 ⌘, 打不开 settings.json 时）。 */
  notice: 'agentdeck-desktop:notice',
  boardReady: 'agentdeck-desktop:board-ready',
  shortcut: 'agentdeck-desktop:shortcut',
  /** 界面 → 主进程：Edit › Undo / Redo 这次是文字的撤销，让主进程对聚焦的 frame 做 webContents.undo() / redo()。 */
  nativeEdit: 'agentdeck-desktop:native-edit',
} as const;

export interface StartupInfo {
  /** 给用户看的提示（英文），例如读登录 shell 环境失败。 */
  warnings: string[];
  /** tmux 起不来的原因；正常为 null。 */
  tmuxError: AgentDeckErrorData | null;
  /** AGENTDECK_DEMO=1：自动把这个仓库加成项目、开演示终端。 */
  demo: { repoPath: string } | null;
  /** AGENTDECK_SCREENSHOT 模式。 */
  screenshot: boolean;
  /** 窗口用 hiddenInset 标题栏（macOS）：顶栏左边要给红黄绿按钮留位置（MVP v2 · V1）。旧的主进程没有这一项。 */
  trafficLights?: boolean;
}

export interface BoardReadyInfo {
  /** 白板上看得见的终端窗口数，截图模式等它们都有输出。 */
  visibleTerminals: number;
}

export interface DesktopBridge {
  startup(): Promise<StartupInfo>;
  /** 再起一次 tmux-host。返回新的错误，成功为 null。 */
  retryTmux(): Promise<AgentDeckErrorData | null>;
  /** 用编辑器打开 settings.json；打不开时在 Finder 里显示，返回要给用户看的提示。 */
  openSettings(): Promise<{ opened: 'editor' } | { opened: 'finder'; message: string } | null>;
  /** 主进程发来的提示。 */
  onNotice(listener: (message: string) => void): void;
  boardReady(info: BoardReadyInfo): void;
  onShortcut(listener: (id: MenuShortcutId) => void): void;
  /** 系统的撤销 / 重做（输入框、网页里的文字），菜单的 Undo / Redo 不归白板时用。 */
  nativeEdit(action: 'undo' | 'redo'): void;
}

declare global {
  interface Window {
    agentdeckDesktop?: DesktopBridge;
    agentdeckFiles?: { pathFor(file: File): string };
  }
}
