// 启动终端 utilityProcess（以后跑 tmux-host），把窗口端口转交给它。
// 现在跑的是 src/utility/echo-host.ts，只会回显。

import type { HostControlMessage, WindowKey } from '../shared/host-protocol.ts';
import type { TerminalPortSink } from './terminal-ports.ts';

/** Electron UtilityProcess 里用到的部分。 */
export interface UtilityProcessLike<P> {
  postMessage(message: unknown, transfer?: P[]): void;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface HostProcess<P> extends TerminalPortSink<P> {
  post(message: HostControlMessage): void;
  stop(): void;
}

export function startHostProcess<P>(deps: {
  fork: () => UtilityProcessLike<P>;
  onExit?: (code: number) => void;
}): HostProcess<P> {
  const child = deps.fork();
  let alive = true;
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
