import { describe, expect, it, vi } from 'vitest';
import { IPC, type AgentDeckEvent } from '@agentdeck/contracts';
import { createEmitter } from '../src/main/events.ts';
import { startHostProcess } from '../src/main/host-process.ts';
import { installIpc, type IpcMainLike, type IpcSenderEvent } from '../src/main/ipc.ts';
import { createServiceRegistry } from '../src/main/registry.ts';
import { createTerminalPortBroker, type PortReceiver } from '../src/main/terminal-ports.ts';

type Port = { name: string };

function fakeWebContents(id: number) {
  const destroyed: (() => void)[] = [];
  let alive = true;
  return {
    id,
    isDestroyed: () => !alive,
    send: vi.fn(),
    postMessage: vi.fn(),
    once: (_event: 'destroyed', listener: () => void) => destroyed.push(listener),
    destroy() {
      alive = false;
      destroyed.forEach((l) => l());
    },
  };
}

describe('emit', () => {
  it('broadcasts to every live window on IPC.event', () => {
    const a = fakeWebContents(1);
    const b = fakeWebContents(2);
    const c = fakeWebContents(3);
    c.destroy();
    const emit = createEmitter(() => [a, b, c]);
    const event: AgentDeckEvent = { type: 'app.window-shown' };
    emit(event);
    expect(a.send).toHaveBeenCalledWith(IPC.event, event);
    expect(b.send).toHaveBeenCalledWith(IPC.event, event);
    expect(c.send).not.toHaveBeenCalled();
  });
});

describe('terminal port broker', () => {
  it('gives port1 to the window and port2 to the host, per window', () => {
    let n = 0;
    const sink = { attachWindow: vi.fn(), detachWindow: vi.fn() };
    const broker = createTerminalPortBroker<Port>({
      createChannel: () => ({ port1: { name: `p1-${++n}` }, port2: { name: `p2-${n}` } }),
      sink,
    });
    const win = fakeWebContents(5);
    broker.open(win);
    broker.open(win); // 页面刷新
    expect(win.postMessage.mock.calls).toEqual([
      [IPC.terminalPort, null, [{ name: 'p1-1' }]],
      [IPC.terminalPort, null, [{ name: 'p1-2' }]],
    ]);
    expect(sink.attachWindow.mock.calls).toEqual([
      [5, { name: 'p2-1' }],
      [5, { name: 'p2-2' }],
    ]);
    win.destroy();
    expect(sink.detachWindow).toHaveBeenCalledTimes(1);
    expect(sink.detachWindow).toHaveBeenCalledWith(5);
  });
});

describe('host process', () => {
  it('forwards window ports and stops posting after exit', () => {
    let onExit: (code: number) => void = () => {};
    const child = {
      postMessage: vi.fn(),
      on: (_e: 'exit', l: (code: number) => void) => (onExit = l),
      kill: vi.fn(() => true),
    };
    const exited = vi.fn();
    const host = startHostProcess<Port>({ fork: () => child, onExit: exited });
    host.attachWindow(1, { name: 'p2' });
    host.detachWindow(1);
    expect(child.postMessage.mock.calls).toEqual([
      [{ type: 'window-port', windowId: 1 }, [{ name: 'p2' }]],
      [{ type: 'window-closed', windowId: 1 }, undefined],
    ]);
    onExit(3);
    host.post({ type: 'window-closed', windowId: 2 });
    host.stop();
    expect(child.postMessage).toHaveBeenCalledTimes(2);
    expect(child.kill).not.toHaveBeenCalled();
    expect(exited).toHaveBeenCalledWith(3);
  });
});

describe('installIpc', () => {
  function setup() {
    const handlers = new Map<string, (event: IpcSenderEvent<Port>, ...args: unknown[]) => unknown>();
    const ipcMain: IpcMainLike<Port> = {
      handle: (channel, l) => void handlers.set(channel, l),
      on: (channel, l) => handlers.set(channel, l),
    };
    const registry = createServiceRegistry();
    const terminalPorts = { open: vi.fn() };
    installIpc({ ipcMain, registry, terminalPorts });
    const win = fakeWebContents(9) as unknown as PortReceiver<Port>;
    const top: IpcSenderEvent<Port> = { sender: win, senderFrame: { parent: null } };
    const sub: IpcSenderEvent<Port> = { sender: win, senderFrame: { parent: {} } };
    const call = (channel: string, event: IpcSenderEvent<Port>, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
    return { registry, terminalPorts, top, sub, call };
  }

  it('routes invoke and send with the sender id as context', async () => {
    const { registry, top, call } = setup();
    const seen: unknown[] = [];
    registry.register('app', {
      getSettings: async () => registry.context() as never,
      setBadge: (count) => void seen.push([count, registry.context()]),
    });
    expect(await call(IPC.invoke, top, { service: 'app', method: 'getSettings', args: [] })).toEqual({ senderId: 9 });
    call(IPC.send, top, { service: 'app', method: 'setBadge', args: [2] });
    expect(seen).toEqual([[2, { senderId: 9 }]]);
  });

  it('opens a terminal port on request', () => {
    const { terminalPorts, top, call } = setup();
    call(IPC.terminalPort, top);
    expect(terminalPorts.open).toHaveBeenCalledWith(top.sender);
  });

  it('ignores sub-frames', async () => {
    const { registry, terminalPorts, sub, call } = setup();
    const setBadge = vi.fn();
    registry.register('app', { setBadge });
    expect(await call(IPC.invoke, sub, { service: 'app', method: 'setBadge', args: [] })).toEqual({
      error: expect.objectContaining({ code: 'invalid-argument' }),
    });
    call(IPC.send, sub, { service: 'app', method: 'setBadge', args: [1] });
    call(IPC.terminalPort, sub);
    expect(setBadge).not.toHaveBeenCalled();
    expect(terminalPorts.open).not.toHaveBeenCalled();
  });
});
