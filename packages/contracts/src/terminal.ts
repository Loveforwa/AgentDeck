// 终端：进程由 AgentDeck 自己的 tmux 实例（tmux -L agentdeck）托管，界面只负责显示。
// 需求见「5 · 终端窗口」。实现：packages/tmux-host（线 1），运行在 utilityProcess。

import type { AbsPath, IsoTime, TermSize, TerminalId, ViewId } from './common.ts';

/** tmux 窗格里固定设置的环境变量，钩子靠它认出是哪个终端。 */
export const TERMINAL_ID_ENV = 'AGENTDECK_TERM';

export interface CreateTerminalRequest {
  cmd: string;
  args: string[];
  cwd: AbsPath;
  /** 会和 TERMINAL_ID_ENV 合并；不能覆盖它。 */
  env?: Record<string, string>;
  size?: TermSize;
}

export interface TerminalInfo {
  id: TerminalId;
  /** 进程当前的目录（tmux 的 pane_current_path）。 */
  cwd: AbsPath;
  /** 当前前台命令（tmux 的 pane_current_command）。 */
  command: string;
  alive: boolean;
  /** 进程已退出时的退出码。 */
  exitCode: number | null;
  lastActivityAt: IsoTime | null;
}

export interface TerminalHost {
  /** 在 tmux 里新建会话。应用退出后会话继续存在。 */
  create(req: CreateTerminalRequest): Promise<{ id: TerminalId }>;
  kill(id: TerminalId): Promise<void>;
  /** 重开应用时用它对上保存的窗口。 */
  list(): Promise<TerminalInfo[]>;

  /** 只为视口里的终端接上显示，移出视口就 detach。输出通过 TerminalDataChannel 推送。 */
  attach(id: TerminalId, size: TermSize): Promise<{ viewId: ViewId }>;
  detach(viewId: ViewId): Promise<void>;
  /** 用户输入。不等待返回。 */
  write(viewId: ViewId, data: string): void;
  /** 只在改大小松手后调用一次。 */
  resize(viewId: ViewId, size: TermSize): void;

  /** 不用接上显示就能发按键（tmux send-keys），用于批准请求、填入命令。 */
  sendKeys(id: TerminalId, keys: string[]): Promise<void>;
  /** 最后 n 行纯文本（tmux capture-pane），给摘要卡用。 */
  lastLines(id: TerminalId, n: number): Promise<string[]>;
  /** 在系统终端里接上同一个会话用的命令。 */
  attachCommand(id: TerminalId): Promise<string>;
}

/**
 * 终端输出量大，不走普通事件通道，走单独的 MessagePort。
 * 每条消息是一个 view 的一段原始输出（含转义序列）。
 */
export interface TerminalDataMessage {
  viewId: ViewId;
  data: string;
}

export type TerminalEvent =
  /** 有新输出（tmux monitor-activity）。没接上显示的终端也会发。 */
  | { type: 'terminal.activity'; id: TerminalId; at: IsoTime }
  /** 一段时间没有输出（tmux monitor-silence，默认 3 秒）。 */
  | { type: 'terminal.silence'; id: TerminalId; at: IsoTime }
  /** 输出里出现了可点的地址。来自 pipe-pane 抄送，由 port-watch 识别。 */
  | { type: 'terminal.link'; id: TerminalId; link: TerminalLink }
  | { type: 'terminal.exit'; id: TerminalId; code: number }
  /** tmux 服务本身没了（例如电脑重启后第一次启动）。 */
  | { type: 'terminal.host-lost' };

export type TerminalLink =
  | { kind: 'localhost'; url: string }
  | { kind: 'file'; path: string; line?: number; column?: number };
