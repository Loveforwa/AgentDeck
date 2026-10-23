// 内联的最小假服务，只用来验证 IPC 全链路（调用、事件、fire-and-forget、终端端口）。
// 正式的假实现在 tools/fakes，组装时由真实实现替换；这里不依赖它们。

import type { AppService, Settings, TerminalHost, TerminalId, ViewId } from '@agentdeck/contracts';
import type { Emit } from './events.ts';
import type { HostProcess } from './host-process.ts';
import type { ServiceRegistry } from './registry.ts';

const DEFAULT_SETTINGS: Settings = {
  closeWindow: 'background',
  notifications: true,
  editorCommand: 'code -g',
  terminalApp: 'Terminal',
  defaultAgent: 'claude',
  agents: {},
  approvals: { destructivePatterns: [] },
};

export function registerDevServices(deps: {
  registry: ServiceRegistry;
  emit: Emit;
  host: HostProcess<unknown>;
  setBadge: (count: number) => void;
}): void {
  const { registry, emit, host } = deps;
  let settings = DEFAULT_SETTINGS;

  // app：updateSettings 把改动合并后原样返回（echo），并推一条 app.settings 事件。
  const app: Partial<AppService> = {
    getSettings: async () => settings,
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      emit({ type: 'app.settings', settings });
      return settings;
    },
    setBadge: (count) => deps.setBadge(count),
  };
  registry.register('app', app);

  // terminals：attach 记下 view 属于哪个窗口；write 交给回显进程，从该窗口的端口原样回来。
  let nextView = 1;
  const terminals: Partial<TerminalHost> = {
    attach: async (_id: TerminalId) => {
      const ctx = registry.context();
      if (ctx === undefined) throw new Error('attach called outside of an IPC call');
      const viewId = `echo-view-${nextView++}` as ViewId;
      host.post({ type: 'echo-attach', viewId, windowId: ctx.senderId });
      return { viewId };
    },
    detach: async () => {},
    write: (viewId, data) => host.post({ type: 'echo-write', viewId, data }),
    resize: () => {},
  };
  registry.register('terminals', terminals);
}
