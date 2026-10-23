// 事件广播：emit(event) 发给所有还活着的窗口。

import { IPC, type AgentDeckEvent } from '@agentdeck/contracts';

/** webContents 里用到的部分。 */
export interface EventTarget {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export type Emit = (event: AgentDeckEvent) => void;

export function createEmitter(listTargets: () => readonly EventTarget[]): Emit {
  return (event) => {
    for (const target of listTargets()) {
      if (!target.isDestroyed()) target.send(IPC.event, event);
    }
  };
}
