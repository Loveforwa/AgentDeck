// 终端 utilityProcess：跑真的 tmux-host（packages/tmux-host），端口和调用由主进程转交（tmux-host/AGENTS.md「给组装」）。
//
// - 输出：tmux-host 的 onData 按 viewId 找到发起 attach 的窗口，直接写进该窗口的 MessagePort，不经过主进程。
//   attach 返回之前到的输出先按 viewId 存着，登记好窗口后补发。
// - 窗口刷新（同一窗口发来新端口）或关掉：detach 这个窗口的所有 view。
// - 链接识别：port-watch 的 createLinkWatcher 作为 linkWatcher 注入（服务包之间不能互相 import，在这里接）。
// - tmux 起不来（没装、版本太低）：回 start-failed；之后的每次调用都先再试一次，界面的 Retry 就是再调一次。

import type { MessagePortMain } from 'electron';
import { AgentDeckError, type AgentDeckErrorData, type TerminalDataMessage, type ViewId } from '@agentdeck/contracts';
import { createLinkWatcher } from '@agentdeck/port-watch';
import { startTmuxHost, type TmuxHost } from '@agentdeck/tmux-host';
import type { HostControlMessage, HostInitOptions, HostReplyMessage, WindowKey } from '../shared/host-protocol.ts';
import { toErrorData } from '../shared/wire.ts';

const windows = new Map<WindowKey, MessagePortMain>();
const views = new Map<ViewId, WindowKey>();
/** attach 返回之前就到了的输出。 */
const early = new Map<ViewId, TerminalDataMessage[]>();
const seen = new Set<ViewId>();
let options: HostInitOptions | null = null;
let host: TmuxHost | null = null;
let starting: Promise<TmuxHost> | null = null;

function reply(message: HostReplyMessage): void {
  process.parentPort.postMessage(message);
}

function deliver(message: TerminalDataMessage): void {
  const windowId = views.get(message.viewId);
  if (windowId === undefined) {
    const list = early.get(message.viewId) ?? [];
    if (list.length < 256) list.push(message);
    early.set(message.viewId, list);
    return;
  }
  windows.get(windowId)?.postMessage(message);
  if (!seen.has(message.viewId)) {
    seen.add(message.viewId);
    reply({ type: 'first-data', viewId: message.viewId, windowId });
  }
}

function ensureHost(): Promise<TmuxHost> {
  if (host) return Promise.resolve(host);
  if (!options) return Promise.reject(new AgentDeckError({ code: 'internal', message: 'Terminal host is not configured' }));
  if (!starting) {
    const opts = options;
    starting = startTmuxHost({
      env: opts.env,
      socketName: opts.socketName,
      configPath: opts.configPath,
      runDir: opts.runDir,
      linkWatcher: () => createLinkWatcher(),
      onEvent: (event) => reply({ type: 'event', event }),
      onData: deliver,
    }).then(
      (h) => {
        host = h;
        starting = null;
        reply({ type: 'ready', tmuxVersion: h.tmuxVersion });
        return h;
      },
      (err: unknown) => {
        starting = null;
        reply({ type: 'start-failed', error: toErrorData(err) });
        throw err;
      },
    );
  }
  return starting;
}

async function detachWindowViews(windowId: WindowKey): Promise<void> {
  const mine = [...views].filter(([, w]) => w === windowId).map(([v]) => v);
  for (const viewId of mine) {
    views.delete(viewId);
    early.delete(viewId);
    await host?.detach(viewId).catch(() => undefined);
  }
}

async function call(msg: Extract<HostControlMessage, { type: 'call' }>): Promise<void> {
  try {
    const h = await ensureHost();
    const fn = (h as unknown as Record<string, (...args: unknown[]) => unknown>)[msg.method];
    if (typeof fn !== 'function') throw new AgentDeckError({ code: 'not-found', message: `terminals.${msg.method}` });
    const result = await fn.apply(h, msg.args);
    if (msg.method === 'attach' && msg.windowId !== undefined) {
      const viewId = (result as { viewId: ViewId }).viewId;
      if (!windows.has(msg.windowId)) {
        // 窗口在 attach 途中关了或刷新了：这个 view 没人看，直接 detach
        await h.detach(viewId).catch(() => undefined);
      } else {
        views.set(viewId, msg.windowId);
        for (const m of early.get(viewId) ?? []) deliver(m);
        early.delete(viewId);
      }
    }
    if (msg.method === 'detach') {
      views.delete(msg.args[0] as ViewId);
      seen.delete(msg.args[0] as ViewId);
    }
    if (msg.callId !== 0) reply({ type: 'result', callId: msg.callId, result: result ?? null });
  } catch (err) {
    const error: AgentDeckErrorData = toErrorData(err);
    if (msg.callId !== 0) reply({ type: 'error', callId: msg.callId, error });
    else console.error(`[terminal-host] terminals.${msg.method}: ${error.message}`);
  }
}

process.parentPort.on('message', (event) => {
  const msg = event.data as HostControlMessage;
  switch (msg.type) {
    case 'init':
      options = msg.options;
      ensureHost().catch(() => undefined);
      return;
    case 'window-port': {
      const port = event.ports[0];
      if (port === undefined) return;
      const old = windows.get(msg.windowId);
      windows.set(msg.windowId, port);
      port.start();
      if (old) {
        old.close();
        void detachWindowViews(msg.windowId);
      }
      return;
    }
    case 'window-closed':
      windows.get(msg.windowId)?.close();
      windows.delete(msg.windowId);
      void detachWindowViews(msg.windowId);
      return;
    case 'call':
      void call(msg);
      return;
    case 'stop':
      void (async () => {
        try {
          if (host) await (msg.killServer ? host.killServer().then(() => host?.dispose()) : host.dispose());
        } finally {
          reply({ type: 'stopped' });
        }
      })();
      return;
  }
});
