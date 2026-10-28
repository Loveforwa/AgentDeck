// 主进程里的 TerminalHost：转发层，把调用交给终端 utilityProcess（跑 tmux-host），等它回结果。
// attach 时带上发起调用的窗口（registry.context().senderId），utilityProcess 据此把输出写进这个窗口的端口
// （apps/desktop/CONTRACT_NOTES.md 第 4 条、tmux-host/CONTRACT_NOTES.md 第 8 条）。不 import Electron，方便单测。

import { AgentDeckError, type AgentDeckErrorData, type TerminalEvent, type TerminalHost, type ViewId } from '@agentdeck/contracts';
import type { HostControlMessage, HostMethod, HostReplyMessage, WindowKey } from '../shared/host-protocol.ts';

export interface HostChannel {
  post(message: HostControlMessage): void;
}

export interface TerminalProxy extends TerminalHost {
  /** utilityProcess 发来的消息交给这里。 */
  handle(message: HostReplyMessage): void;
  /** 终端事件（terminal.*）。 */
  onEvent(listener: (event: TerminalEvent) => void): () => void;
  /** 某个 view 第一次有输出。 */
  onFirstData(listener: (viewId: ViewId, windowId: WindowKey) => void): () => void;
  /** 最近一次 tmux 起不来的原因；起来了为 null。 */
  readonly startError: AgentDeckErrorData | null;
  readonly tmuxVersion: string | null;
  /** 停 tmux-host：killServer 为 true 时结束整个 tmux 服务（Stop all and quit）。最多等 timeoutMs。 */
  stop(killServer: boolean, timeoutMs?: number): Promise<void>;
  /** utilityProcess 退出了：所有在等的调用失败。 */
  hostExited(code: number): void;
}

export function createTerminalProxy(deps: {
  channel: HostChannel;
  /** 发起调用的窗口；不在 IPC 调用里（例如主进程自己调）时为 undefined。 */
  currentWindow: () => WindowKey | undefined;
  /** 每次调用的超时，默认 30 秒（tmux 命令都很快，卡住通常是 utilityProcess 没了）。 */
  timeoutMs?: number;
}): TerminalProxy {
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  const eventListeners = new Set<(event: TerminalEvent) => void>();
  const dataListeners = new Set<(viewId: ViewId, windowId: WindowKey) => void>();
  const stopWaiters: (() => void)[] = [];
  let nextId = 1;
  let startError: AgentDeckErrorData | null = null;
  let tmuxVersion: string | null = null;
  let exited = false;

  function call<T>(method: HostMethod, args: unknown[], withWindow = false): Promise<T> {
    if (exited) {
      return Promise.reject(new AgentDeckError({ code: 'tmux-unavailable', message: 'The terminal host stopped. Restart AgentDeck.' }));
    }
    const callId = nextId++;
    const windowId = withWindow ? deps.currentWindow() : undefined;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        reject(new AgentDeckError({ code: 'timeout', message: `terminals.${method} timed out` }));
      }, deps.timeoutMs ?? 30_000);
      pending.set(callId, { resolve: resolve as (v: unknown) => void, reject, timer });
      deps.channel.post({ type: 'call', callId, method, args, ...(windowId !== undefined ? { windowId } : {}) });
    });
  }

  function fire(method: HostMethod, args: unknown[]): void {
    if (!exited) deps.channel.post({ type: 'call', callId: 0, method, args });
  }

  return {
    get startError() {
      return startError;
    },
    get tmuxVersion() {
      return tmuxVersion;
    },
    create: (req) => call('create', [req]),
    kill: (id) => call('kill', [id]),
    list: () => call('list', []),
    attach: (id, size) => call('attach', [id, size], true),
    detach: (viewId) => call('detach', [viewId]),
    write: (viewId, data) => fire('write', [viewId, data]),
    resize: (viewId, size) => fire('resize', [viewId, size]),
    sendKeys: (id, keys) => call('sendKeys', [id, keys]),
    sendText: (id, text) => call('sendText', [id, text]),
    lastLines: (id, n) => call('lastLines', [id, n]),
    attachCommand: (id) => call('attachCommand', [id]),
    recentLinks: (id) => call('recentLinks', [id]),

    handle(message) {
      switch (message.type) {
        case 'ready':
          startError = null;
          tmuxVersion = message.tmuxVersion;
          return;
        case 'start-failed':
          startError = message.error;
          return;
        case 'result':
        case 'error': {
          const p = pending.get(message.callId);
          if (!p) return;
          pending.delete(message.callId);
          clearTimeout(p.timer);
          if (message.type === 'result') p.resolve(message.result);
          else p.reject(new AgentDeckError(message.error));
          return;
        }
        case 'event':
          for (const l of eventListeners) l(message.event);
          return;
        case 'first-data':
          for (const l of dataListeners) l(message.viewId, message.windowId);
          return;
        case 'stopped':
          for (const w of stopWaiters.splice(0)) w();
          return;
      }
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onFirstData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    stop(killServer, timeoutMs = 3000) {
      if (exited) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        stopWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        deps.channel.post({ type: 'stop', killServer });
      });
    },
    hostExited(code) {
      exited = true;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new AgentDeckError({ code: 'tmux-unavailable', message: `The terminal host exited (code ${code}).` }));
        pending.delete(id);
      }
      for (const w of stopWaiters.splice(0)) w();
    },
  };
}
