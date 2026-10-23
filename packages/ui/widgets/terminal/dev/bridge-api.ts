// ?real=1 时用的 api：terminals / agents / app 的几个方法走 tmux-host 的 dev bridge（packages/tmux-host/dev/bridge.ts），
// 其余（status、board……）仍是假服务。终端事件和输出从 SSE 来。
// 只给 dev 页面用；产品里 window.agentdeck 由 apps/desktop 的 preload 提供。

import { AgentDeckError, isAgentDeckErrorData } from '@agentdeck/contracts';
import type { AgentDeckEvent, TerminalDataMessage, TerminalHost } from '@agentdeck/contracts';
import type { FakeApi } from '@agentdeck/fakes';

async function call(service: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch('/bridge/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service, method, args }) });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw isAgentDeckErrorData(body.error) ? new AgentDeckError(body.error) : new Error(String(body.error));
  return body.result;
}

export function connectBridge(api: FakeApi, onStatus: (text: string) => void): void {
  const terminals: TerminalHost = {
    create: (req) => call('terminals', 'create', [req]) as ReturnType<TerminalHost['create']>,
    kill: (id) => call('terminals', 'kill', [id]) as Promise<void>,
    list: () => call('terminals', 'list', []) as ReturnType<TerminalHost['list']>,
    attach: (id, size) => call('terminals', 'attach', [id, size]) as ReturnType<TerminalHost['attach']>,
    detach: (viewId) => call('terminals', 'detach', [viewId]) as Promise<void>,
    write: (viewId, data) => void call('terminals', 'write', [viewId, data]).catch(() => {}),
    resize: (viewId, size) => void call('terminals', 'resize', [viewId, size]).catch(() => {}),
    sendKeys: (id, keys) => call('terminals', 'sendKeys', [id, keys]) as Promise<void>,
    lastLines: (id, n) => call('terminals', 'lastLines', [id, n]) as Promise<string[]>,
    attachCommand: (id) => call('terminals', 'attachCommand', [id]) as Promise<string>,
    recentLinks: (id) => call('terminals', 'recentLinks', [id]) as ReturnType<TerminalHost['recentLinks']>,
  };
  Object.assign(api, { terminals });
  Object.assign(api.agents, { start: (req: unknown) => call('agents', 'start', [req]) });
  Object.assign(api.app, {
    openInSystemTerminal: (id: unknown) => call('app', 'openInSystemTerminal', [id]),
    openInEditor: (path: unknown, line?: unknown) => call('app', 'openInEditor', [path, line]),
  });

  const dataListeners = new Set<(m: TerminalDataMessage) => void>();
  Object.assign(api, {
    onTerminalData: (l: (m: TerminalDataMessage) => void) => {
      dataListeners.add(l);
      return () => dataListeners.delete(l);
    },
  });
  const es = new EventSource('/bridge/events');
  es.onopen = () => onStatus('bridge connected');
  es.onerror = () => onStatus('bridge disconnected — run: pnpm --filter @agentdeck/tmux-host dev:bridge');
  es.onmessage = (e: MessageEvent<string>) => {
    const msg = JSON.parse(e.data) as { kind: 'event'; event: AgentDeckEvent } | { kind: 'data'; message: TerminalDataMessage };
    if (msg.kind === 'data') for (const l of dataListeners) l(msg.message);
    else api.bus.emit(msg.event);
  };
}
