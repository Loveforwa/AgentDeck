// 终端输出按 viewId 分给各个窗口。onTerminalData 是整个应用一条 MessagePort，每个 api 只订阅一次。
// tmux 接上后的第一段输出可能比 attach() 的返回值先到（输出走 MessagePort，返回值走 invoke），
// 所以还没人认领的 viewId 先缓存一会儿，认领时补上。

import type { AgentDeckApi, TerminalId, TerminalInfo, Unsubscribe, ViewId } from '@agentdeck/contracts';

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
export function listTerminals(api: Pick<AgentDeckApi, 'terminals'>): Promise<TerminalInfo[]> {
  const cached = lists.get(api);
  if (cached && Date.now() - cached.at < 500) return cached.promise;
  const promise = api.terminals.list();
  lists.set(api, { at: Date.now(), promise });
  promise.catch(() => lists.delete(api));
  return promise;
}

/** 当前目录、正在跑的命令都没有事件，只能轮询（IS-57、X6）。所有终端窗口共用一个定时器，每轮一次 list()。 */
export const CWD_REFRESH_MS = 3000;
/** 用户敲完回车后多久看一眼正在跑的命令（X6：跑了这么久以上的命令才记得到）。 */
export const AFTER_INPUT_MS = 1500;

interface InfoWatch {
  listeners: Set<{ id: TerminalId; cb: (info: TerminalInfo | null) => void }>;
  stop(): void;
}

const infoWatches = new WeakMap<object, InfoWatch>();

/**
 * 盯着一个终端在 list() 里的信息（当前目录 cwd、正在跑的命令 foregroundCommand）：订阅时取一次，之后每 CWD_REFRESH_MS 取一次，
 * 这个终端安静下来（terminal.silence，命令跑完、cd 完）时、用户输入后 AFTER_INPUT_MS 也取。终端不在 list() 里时给 null。
 */
export function watchTerminalInfo(api: Pick<AgentDeckApi, 'terminals' | 'on'>, id: TerminalId, cb: (info: TerminalInfo | null) => void): Unsubscribe {
  let w = infoWatches.get(api);
  if (!w) {
    const listeners: InfoWatch['listeners'] = new Set();
    // 定时和 silence 时直接 list()，不走 listTerminals 的 500ms 合并（那是给重开应用时一起挂上的窗口用的，会拿到旧结果）
    const load = () => {
      api.terminals.list().then(
        (list) => {
          for (const l of listeners) l.cb(list.find((t) => t.id === l.id) ?? null);
        },
        () => {
          // 取不到就保持上一次的；下一轮再试
        },
      );
    };
    const timer = setInterval(load, CWD_REFRESH_MS);
    let afterInput: ReturnType<typeof setTimeout> | null = null;
    const watched = (tid: TerminalId) => [...listeners].some((l) => l.id === tid);
    const offs = [
      api.on('terminal.silence', (e) => {
        if (watched(e.id)) load();
      }),
      api.on('terminal.input', (e) => {
        if (afterInput || !watched(e.id)) return;
        afterInput = setTimeout(() => {
          afterInput = null;
          load();
        }, AFTER_INPUT_MS);
      }),
    ];
    const created: InfoWatch = {
      listeners,
      stop: () => {
        clearInterval(timer);
        if (afterInput) clearTimeout(afterInput);
        offs.forEach((off) => off());
        infoWatches.delete(api);
      },
    };
    infoWatches.set(api, created);
    w = created;
  }
  const watch = w;
  const entry = { id, cb };
  watch.listeners.add(entry);
  void listTerminals(api).then(
    (list) => {
      if (watch.listeners.has(entry)) cb(list.find((t) => t.id === id) ?? null);
    },
    () => {},
  );
  return () => {
    watch.listeners.delete(entry);
    if (watch.listeners.size === 0) watch.stop();
  };
}

/** 盯着一个终端的当前目录（TerminalInfo.cwd，IS-57）。终端不在 list() 里时给 null。 */
export function watchTerminalCwd(api: Pick<AgentDeckApi, 'terminals' | 'on'>, id: TerminalId, cb: (cwd: string | null) => void): Unsubscribe {
  return watchTerminalInfo(api, id, (info) => cb(info?.cwd ?? null));
}
