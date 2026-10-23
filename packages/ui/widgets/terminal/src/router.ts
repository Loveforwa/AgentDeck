// 终端输出按 viewId 分给各个窗口。onTerminalData 是整个应用一条 MessagePort，每个 api 只订阅一次。
// tmux 接上后的第一段输出可能比 attach() 的返回值先到（输出走 MessagePort，返回值走 invoke），
// 所以还没人认领的 viewId 先缓存一会儿，认领时补上。

import type { AgentDeckApi, TerminalInfo, Unsubscribe, ViewId } from '@agentdeck/contracts';

type Listener = (data: string) => void;

/** 没人认领的输出最多留这么久、这么多。 */
const EARLY_MS = 5000;
const EARLY_MAX = 512 * 1024;

export class TerminalDataRouter {
  private readonly listeners = new Map<ViewId, Listener>();
  private readonly early = new Map<ViewId, { chunks: string[]; size: number; at: number }>();

  constructor(api: Pick<AgentDeckApi, 'onTerminalData'>) {
    api.onTerminalData((m) => this.dispatch(m.viewId, m.data));
  }

  listen(viewId: ViewId, listener: Listener): Unsubscribe {
    this.listeners.set(viewId, listener);
    const buffered = this.early.get(viewId);
    if (buffered) {
      this.early.delete(viewId);
      for (const c of buffered.chunks) listener(c);
    }
    return () => {
      if (this.listeners.get(viewId) === listener) this.listeners.delete(viewId);
      this.early.delete(viewId);
    };
  }

  private dispatch(viewId: ViewId, data: string): void {
    const l = this.listeners.get(viewId);
    if (l) {
      l(data);
      return;
    }
    const now = Date.now();
    for (const [id, e] of this.early) if (now - e.at > EARLY_MS) this.early.delete(id);
    const e = this.early.get(viewId) ?? { chunks: [], size: 0, at: now };
    if (e.size + data.length > EARLY_MAX) return;
    e.chunks.push(data);
    e.size += data.length;
    this.early.set(viewId, e);
  }
}

const routers = new WeakMap<object, TerminalDataRouter>();

export function routerFor(api: AgentDeckApi): TerminalDataRouter {
  let r = routers.get(api);
  if (!r) {
    r = new TerminalDataRouter(api);
    routers.set(api, r);
  }
  return r;
}

const lists = new WeakMap<object, { at: number; promise: Promise<TerminalInfo[]> }>();

/** 重开应用时每个终端窗口都要 list() 一次（T6），同一时刻的合成一次调用。 */
export function listTerminals(api: AgentDeckApi): Promise<TerminalInfo[]> {
  const cached = lists.get(api);
  if (cached && Date.now() - cached.at < 500) return cached.promise;
  const promise = api.terminals.list();
  lists.set(api, { at: Date.now(), promise });
  promise.catch(() => lists.delete(api));
  return promise;
}
