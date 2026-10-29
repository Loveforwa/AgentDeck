// 主进程和终端 utilityProcess（跑 packages/tmux-host）之间的消息（经 parentPort）。
// 这不是 contracts 的一部分，只在 apps/desktop 内部用。
// 终端输出本身不走这里：utilityProcess 直接往每个窗口的 MessagePort 写 TerminalDataMessage。

import type { AgentDeckErrorData, TerminalEvent, TerminalHost, ViewId } from '@agentdeck/contracts';

/** 窗口 id 就是该窗口 webContents.id。 */
export type WindowKey = number;

/** 主进程转给 utilityProcess 的 TerminalHost 方法。 */
export type HostMethod = keyof TerminalHost & string;

export const HOST_METHODS: readonly HostMethod[] = [
  'create',
  'kill',
  'list',
  'attach',
  'detach',
  'write',
  'resize',
  'sendKeys',
  'sendText',
  'lastLines',
  'attachCommand',
  'recentLinks',
];

export interface HostInitOptions {
  /** 登录 shell 的环境。 */
  env: Record<string, string>;
  socketName: string;
  configPath: string;
  runDir: string;
}

export type HostControlMessage =
  /** 第一条消息：起 tmux-host。失败时回 start-failed，之后每次调用都会再试一次（= Retry）。 */
  | { type: 'init'; options: HostInitOptions }
  /** 附带 ports[0]：该窗口接收终端输出的端口。同一窗口重新发送时替换旧端口（页面刷新），旧端口上的 view 全部 detach。 */
  | { type: 'window-port'; windowId: WindowKey }
  /** 窗口关了：detach 它的所有 view，否则 tmux 里会留着 attach 客户端。 */
  | { type: 'window-closed'; windowId: WindowKey }
  /** 调 TerminalHost 的方法。callId 为 0 时不回结果（write / resize）。attach 带 windowId：输出写到这个窗口的端口。 */
  | { type: 'call'; callId: number; method: HostMethod; args: unknown[]; windowId?: WindowKey }
  /** 退出前：dispose（不结束 tmux 里的会话）或 kill-server（Stop all and quit）。完成后回 stopped。 */
  | { type: 'stop'; killServer: boolean };

export type HostReplyMessage =
  | { type: 'ready'; tmuxVersion: string }
  | { type: 'start-failed'; error: AgentDeckErrorData }
  | { type: 'result'; callId: number; result: unknown }
  | { type: 'error'; callId: number; error: AgentDeckErrorData }
  | { type: 'event'; event: TerminalEvent }
  /** 某个 view 第一次有输出（截图模式据此判断“终端接上并有输出”）。 */
  | { type: 'first-data'; viewId: ViewId; windowId: WindowKey }
  | { type: 'stopped' };
