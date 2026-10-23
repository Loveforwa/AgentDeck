// 终端输出的 MessagePort：每个窗口一条 MessageChannelMain，
// port1 交给窗口的 preload，port2 交给终端 utilityProcess。之后输出直接走端口，不经过主进程。

import { IPC } from '@agentdeck/contracts';
import type { WindowKey } from '../shared/host-protocol.ts';

/** 窗口 webContents 里用到的部分。 */
export interface PortReceiver<P> {
  id: number;
  isDestroyed(): boolean;
  postMessage(channel: string, message: unknown, transfer: P[]): void;
  once(event: 'destroyed', listener: () => void): void;
}

/** 端口的另一端交给谁（终端 utilityProcess）。 */
export interface TerminalPortSink<P> {
  attachWindow(windowId: WindowKey, port: P): void;
  detachWindow(windowId: WindowKey): void;
}

export interface TerminalPortBroker<P> {
  /** 处理窗口发来的 IPC.terminalPort 请求。页面刷新后会再次请求，旧端口由 sink 替换掉。 */
  open(receiver: PortReceiver<P>): void;
}

export function createTerminalPortBroker<P>(deps: {
  createChannel: () => { port1: P; port2: P };
  sink: TerminalPortSink<P>;
}): TerminalPortBroker<P> {
  const watched = new Set<number>();
  return {
    open(receiver) {
      if (receiver.isDestroyed()) return;
      const { port1, port2 } = deps.createChannel();
      const windowId = receiver.id;
      deps.sink.attachWindow(windowId, port2);
      receiver.postMessage(IPC.terminalPort, null, [port1]);
      if (!watched.has(windowId)) {
        watched.add(windowId);
        receiver.once('destroyed', () => {
          watched.delete(windowId);
          deps.sink.detachWindow(windowId);
        });
      }
    },
  };
}
