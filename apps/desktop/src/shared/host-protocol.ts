// 主进程和终端 utilityProcess 之间的控制消息（经 parentPort）。
// 这不是 contracts 的一部分，只在 apps/desktop 内部用；真正的 tmux-host 接进来时可以扩展。
// 终端输出本身不走这里：utilityProcess 直接往每个窗口的 MessagePort 写 TerminalDataMessage。

import type { ViewId } from '@agentdeck/contracts';

/** 窗口 id 就是该窗口 webContents.id。 */
export type WindowKey = number;

export type HostControlMessage =
  /** 附带 ports[0]：该窗口接收终端输出的端口。同一窗口重新发送时替换旧端口（页面刷新）。 */
  | { type: 'window-port'; windowId: WindowKey }
  | { type: 'window-closed'; windowId: WindowKey }
  // 下面两条只给回显假进程用，验证端口链路；真实 tmux-host 改为走服务调用。
  | { type: 'echo-attach'; viewId: ViewId; windowId: WindowKey }
  | { type: 'echo-write'; viewId: ViewId; data: string };
