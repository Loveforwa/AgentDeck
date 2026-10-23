// 内存事件总线：代替 IPC 的事件通道和终端输出的 MessagePort。
// 所有假服务共用一个总线，createFakeApi 把它的 on / onTerminalData 暴露给界面。

import type {
  AgentDeckEvent,
  AgentDeckEventType,
  EventOf,
  TerminalDataMessage,
  Unsubscribe,
} from '@agentdeck/contracts';

type AnyListener = (event: AgentDeckEvent) => void;

export class FakeEventBus {
  private readonly listeners = new Map<AgentDeckEventType, Set<AnyListener>>();
  private readonly anyListeners = new Set<AnyListener>();
  private readonly dataListeners = new Set<(message: TerminalDataMessage) => void>();
  /** 发过的所有事件，测试里断言用。clearLog() 清空。 */
  readonly log: AgentDeckEvent[] = [];

  on<T extends AgentDeckEventType>(type: T, listener: (event: EventOf<T>) => void): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const l = listener as AnyListener;
    set.add(l);
    return () => {
      set.delete(l);
    };
  }

  /** 收所有事件，调试和录日志用。 */
  onAny(listener: AnyListener): Unsubscribe {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  emit(event: AgentDeckEvent): void {
    this.log.push(event);
    for (const l of [...(this.listeners.get(event.type) ?? [])]) l(event);
    for (const l of [...this.anyListeners]) l(event);
  }

  onTerminalData(listener: (message: TerminalDataMessage) => void): Unsubscribe {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  emitTerminalData(message: TerminalDataMessage): void {
    for (const l of [...this.dataListeners]) l(message);
  }

  /** 某一类发过的事件。 */
  eventsOf<T extends AgentDeckEventType>(type: T): EventOf<T>[] {
    return this.log.filter((e): e is EventOf<T> => e.type === type);
  }

  clearLog(): void {
    this.log.length = 0;
  }
}
