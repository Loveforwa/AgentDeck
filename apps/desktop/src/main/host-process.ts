// 启动终端 utilityProcess（src/utility/tmux-host.ts，跑 packages/tmux-host），转交窗口端口和控制消息，收它的回复。

import type { HostControlMessage, HostReplyMessage, WindowKey } from '../shared/host-protocol.ts';
import type { TerminalPortSink } from './terminal-ports.ts';

/** Electron UtilityProcess 里用到的部分。 */
export interface UtilityProcessLike<P> {
  postMessage(message: unknown, transfer?: P[]): void;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  kill(): boolean;
}

export interface HostProcess<P> extends TerminalPortSink<P> {
  post(message: HostControlMessage): void;
  stop(): void;
}

export function startHostProcess<P>(deps: {
  fork: () => UtilityProcessLike<P>;
  onExit?: (code: number) => void;
  onMessage?: (message: HostReplyMessage) => void;
}): HostProcess<P> {
  const child = deps.fork();
  let alive = true;
  child.on('message', (message) => deps.onMessage?.(message as HostReplyMessage));
  child.on('exit', (code) => {
    alive = false;
    deps.onExit?.(code);
  });
  const post = (message: HostControlMessage, transfer?: P[]) => {
    if (alive) child.postMessage(message, transfer);
  };
  return {
    attachWindow: (windowId: WindowKey, port: P) => post({ type: 'window-port', windowId }, [port]),
    detachWindow: (windowId: WindowKey) => post({ type: 'window-closed', windowId }),
    post: (message) => post(message),
    stop: () => {
      if (alive) child.kill();
    },
  };
}
