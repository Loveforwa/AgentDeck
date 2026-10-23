// 把注册表和终端端口接到 ipcMain 上。Electron 对象从外面传进来，方便单测。

import { IPC } from '@agentdeck/contracts';
import type { ServiceRegistry } from './registry.ts';
import type { PortReceiver, TerminalPortBroker } from './terminal-ports.ts';

export interface IpcSenderEvent<P> {
  sender: PortReceiver<P>;
  /** 发消息的 frame。只接受顶层 frame，子 frame（例如嵌进来的网页）不能调服务。 */
  senderFrame: { parent: unknown } | null;
}

/** ipcMain 里用到的部分。 */
export interface IpcMainLike<P> {
  handle(channel: string, listener: (event: IpcSenderEvent<P>, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: IpcSenderEvent<P>, ...args: unknown[]) => void): unknown;
}

function fromTopFrame(event: IpcSenderEvent<unknown>): boolean {
  return event.senderFrame !== null && event.senderFrame.parent === null;
}

export function installIpc<P>(deps: {
  ipcMain: IpcMainLike<P>;
  registry: ServiceRegistry;
  terminalPorts: TerminalPortBroker<P>;
}): void {
  const { ipcMain, registry, terminalPorts } = deps;

  ipcMain.handle(IPC.invoke, (event, raw) => {
    if (!fromTopFrame(event)) {
      return { error: { code: 'invalid-argument', message: 'IPC is only available to the top frame' } };
    }
    return registry.invoke(raw, { senderId: event.sender.id });
  });

  ipcMain.on(IPC.send, (event, raw) => {
    if (fromTopFrame(event)) registry.send(raw, { senderId: event.sender.id });
  });

  ipcMain.on(IPC.terminalPort, (event) => {
    if (fromTopFrame(event)) terminalPorts.open(event.sender);
  });
}
