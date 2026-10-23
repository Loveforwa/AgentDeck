// 回显假进程：在 utilityProcess 里跑，验证“主进程转交端口 → utilityProcess 直接写给窗口”这条链路。
// 以后换成 packages/tmux-host。

import type { MessagePortMain } from 'electron';
import type { TerminalDataMessage, ViewId } from '@agentdeck/contracts';
import type { HostControlMessage, WindowKey } from '../shared/host-protocol.ts';

const windows = new Map<WindowKey, MessagePortMain>();
const views = new Map<ViewId, WindowKey>();

process.parentPort.on('message', (event) => {
  const msg = event.data as HostControlMessage;
  switch (msg.type) {
    case 'window-port': {
      const port = event.ports[0];
      if (port === undefined) return;
      windows.get(msg.windowId)?.close();
      windows.set(msg.windowId, port);
      port.start();
      return;
    }
    case 'window-closed':
      windows.get(msg.windowId)?.close();
      windows.delete(msg.windowId);
      for (const [viewId, windowId] of views) if (windowId === msg.windowId) views.delete(viewId);
      return;
    case 'echo-attach':
      views.set(msg.viewId, msg.windowId);
      return;
    case 'echo-write': {
      const windowId = views.get(msg.viewId);
      const port = windowId === undefined ? undefined : windows.get(windowId);
      const out: TerminalDataMessage = { viewId: msg.viewId, data: msg.data };
      port?.postMessage(out);
      return;
    }
  }
});
