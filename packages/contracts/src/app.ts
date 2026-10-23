// 应用外壳：系统对话框、外部程序、设置、关闭方式。需求见「9 · 保存与重启」「10 · 全局规则」。
// 实现：apps/desktop 主进程（组装时完成）。

import type { AbsPath, AgentKind, TerminalId } from './common.ts';

export interface Settings {
  /** 关闭窗口时：后台继续（默认）或直接退出。 */
  closeWindow: 'background' | 'quit';
  /** 应用不在前台时发系统通知。 */
  notifications: boolean;
  /** 打开“文件:行号”用的编辑器命令，例如 'code -g'。 */
  editorCommand: string;
  /** Open in system terminal 用的 App，例如 'Terminal'、'iTerm'、'Ghostty'。 */
  terminalApp: string;
  defaultAgent: AgentKind;
  agents: Record<string, AgentSettings>;
  approvals: {
    /** 破坏性命令名单（正则字符串），Approve all 里默认不勾，Auto-approve 不会自动批准。 */
    destructivePatterns: string[];
  };
}

export interface AgentSettings {
  /** 额外的启动参数。 */
  extraArgs: string[];
  /** 没有钩子的 agent：停下 3 秒且最后几行出现这句时算“等你”。 */
  waitingText: string | null;
}

export interface QuitRequest {
  /** false：终端在 tmux 里继续跑（⌘Q）；true：Stop all and quit。 */
  stopTerminals: boolean;
}

export interface AppService {
  /** 用户主目录的绝对路径。散放的终端在这里运行。 */
  homeDir(): Promise<AbsPath>;
  /** 系统的选文件夹窗口。取消返回 null。 */
  pickFolder(opts: { title: string; defaultPath?: AbsPath }): Promise<AbsPath | null>;
  openInEditor(path: AbsPath, line?: number): Promise<void>;
  openInSystemTerminal(id: TerminalId): Promise<void>;
  revealInFinder(path: AbsPath): Promise<void>;
  /** 已跟踪文件以外的删除都移到废纸篓。 */
  moveToTrash(path: AbsPath): Promise<void>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  quit(req: QuitRequest): Promise<void>;
  /** 程序坞角标数字；0 清除。 */
  setBadge(count: number): void;
}

export type AppEvent =
  | { type: 'app.settings'; settings: Settings }
  /** 窗口从后台回来（Close window 之后重新打开）。 */
  | { type: 'app.window-shown' }
  /** 单击系统通知，要跳到这个终端。 */
  | { type: 'app.focus-terminal'; terminalId: TerminalId };
