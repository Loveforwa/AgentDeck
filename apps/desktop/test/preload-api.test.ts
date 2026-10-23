import { describe, expect, it, vi } from 'vitest';
import {
  CONTRACTS_VERSION,
  FIRE_AND_FORGET,
  isAgentDeckErrorData,
  type AgentDeckApi,
  type AgentDeckEvent,
  type InvokeMessage,
  type TerminalId,
  type ViewId,
} from '@agentdeck/contracts';
import { installAgentDeckApi, type ApiManifest, type RawBridge } from '../src/preload/api.ts';
import { SERVICE_METHODS } from '../src/shared/methods.ts';

const manifest: ApiManifest = { methods: SERVICE_METHODS, fireAndForget: FIRE_AND_FORGET, contractsVersion: CONTRACTS_VERSION };

function fakeTransport(reply: (msg: InvokeMessage) => unknown = () => undefined) {
  let emit: (event: AgentDeckEvent) => void = () => {};
  let pushData: (data: unknown) => void = () => {};
  const transport = {
    invoke: vi.fn(async (msg: InvokeMessage) => reply(msg)),
    send: vi.fn(),
    onEvent: (listener: (event: AgentDeckEvent) => void) => {
      emit = listener;
    },
    onTerminalData: (listener: (data: unknown) => void) => {
      pushData = listener;
    },
  } satisfies RawBridge;
  return {
    transport,
    emit: (event: AgentDeckEvent) => emit(event),
    pushData: (data: unknown) => pushData(data),
  };
}

function createAgentDeckApi(bridge: RawBridge): AgentDeckApi {
  return installAgentDeckApi(bridge, manifest, false)!;
}

describe('preload api: calls', () => {
  it('exposes every contract method as a plain function', () => {
    const api = createAgentDeckApi(fakeTransport().transport);
    for (const [service, methods] of Object.entries(SERVICE_METHODS)) {
      for (const method of methods) {
        expect(typeof (api as unknown as Record<string, Record<string, unknown>>)[service]?.[method]).toBe('function');
      }
    }
    expect(api.contractsVersion).toBe(CONTRACTS_VERSION);
  });

  it('invokes { service, method, args } and returns the result', async () => {
    const { transport } = fakeTransport((msg) => ({ echoed: msg }));
    const api = createAgentDeckApi(transport);
    const result = await api.git.log('/repo', 5);
    expect(transport.invoke).toHaveBeenCalledWith({ service: 'git', method: 'log', args: ['/repo', 5] });
    expect(result).toEqual({ echoed: { service: 'git', method: 'log', args: ['/repo', 5] } });
  });

  it('restores { error } into a thrown AgentDeckError', async () => {
    const { transport } = fakeTransport(() => ({
      error: { code: 'branch-in-use', message: 'Branch is checked out elsewhere', detail: 'wt: /x' },
    }));
    const api = createAgentDeckApi(transport);
    const err = await api.git.switchBranch('/r', 'main', 'carry').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isAgentDeckErrorData(err)).toBe(true);
    expect(err).toMatchObject({
      name: 'AgentDeckError',
      code: 'branch-in-use',
      message: 'Branch is checked out elsewhere',
      detail: 'wt: /x',
    });
    expect((err as { toData(): unknown }).toData()).toEqual({
      code: 'branch-in-use',
      message: 'Branch is checked out elsewhere',
      detail: 'wt: /x',
    });
  });

  it('does not mistake ordinary results for errors', async () => {
    const results = [null, undefined, [], { error: 'text' }, { error: { code: 'x', message: 'y' }, other: 1 }];
    for (const value of results) {
      const api = createAgentDeckApi(fakeTransport(() => value).transport);
      await expect(api.board.load()).resolves.toEqual(value);
    }
  });

  it('uses send for FIRE_AND_FORGET methods and returns nothing', () => {
    const { transport } = fakeTransport();
    const api = createAgentDeckApi(transport);
    expect(api.terminals.write('v1' as ViewId, 'x')).toBeUndefined();
    api.terminals.resize('v1' as ViewId, { cols: 100, rows: 30 });
    api.app.setBadge(3);
    expect(transport.send.mock.calls.map(([m]) => m)).toEqual([
      { service: 'terminals', method: 'write', args: ['v1', 'x'] },
      { service: 'terminals', method: 'resize', args: ['v1', { cols: 100, rows: 30 }] },
      { service: 'app', method: 'setBadge', args: [3] },
    ]);
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it('uses invoke for everything else in a fire-and-forget service', async () => {
    const { transport } = fakeTransport(() => ({ viewId: 'v9' }));
    const api = createAgentDeckApi(transport);
    await api.terminals.attach('t1' as TerminalId, { cols: 80, rows: 24 });
    expect(transport.invoke).toHaveBeenCalledTimes(1);
    expect(transport.send).not.toHaveBeenCalled();
  });
});

describe('preload api: events', () => {
  const exit = (code: number): AgentDeckEvent => ({ type: 'terminal.exit', id: 't1' as TerminalId, code });

  it('delivers events only to listeners of that type', () => {
    const { transport, emit } = fakeTransport();
    const api = createAgentDeckApi(transport);
    const onExit = vi.fn();
    const onShown = vi.fn();
    api.on('terminal.exit', onExit);
    api.on('app.window-shown', onShown);
    emit(exit(1));
    emit({ type: 'app.window-shown' });
    expect(onExit).toHaveBeenCalledWith(exit(1));
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after unsubscribe, without affecting other listeners', () => {
    const { transport, emit } = fakeTransport();
    const api = createAgentDeckApi(transport);
    const a = vi.fn();
    const b = vi.fn();
    const offA = api.on('terminal.exit', a);
    api.on('terminal.exit', b);
    emit(exit(1));
    offA();
    offA(); // 重复取消不报错
    emit(exit(2));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('keeps dispatching when a listener throws', () => {
    const { transport, emit } = fakeTransport();
    const api = createAgentDeckApi(transport);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    api.on('terminal.exit', () => {
      throw new Error('bad listener');
    });
    api.on('terminal.exit', after);
    emit(exit(1));
    expect(after).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('allows a listener to unsubscribe itself during dispatch', () => {
    const { transport, emit } = fakeTransport();
    const api = createAgentDeckApi(transport);
    const calls: string[] = [];
    const off = api.on('terminal.exit', () => {
      calls.push('once');
      off();
    });
    api.on('terminal.exit', () => calls.push('always'));
    emit(exit(1));
    emit(exit(2));
    expect(calls).toEqual(['once', 'always', 'always']);
  });
});

describe('preload api: terminal data', () => {
  it('forwards messages until unsubscribed', () => {
    const { transport, pushData } = fakeTransport();
    const api = createAgentDeckApi(transport);
    const listener = vi.fn();
    const off = api.onTerminalData(listener);
    pushData({ viewId: 'v1', data: 'hi' });
    off();
    pushData({ viewId: 'v1', data: 'again' });
    expect(listener.mock.calls).toEqual([[{ viewId: 'v1', data: 'hi' }]]);
  });
});

describe('preload api: main-world install', () => {
  it('is self-contained, so executeInMainWorld can serialize it', async () => {
    // executeInMainWorld 只传函数源码；这里用同样的方式重建，引用了外部变量就会在这里失败。
    const rebuilt = new Function(`return (${installAgentDeckApi.toString()})`)() as typeof installAgentDeckApi;
    const { transport, emit } = fakeTransport(() => ({ error: { code: 'timeout', message: 'Timed out' } }));
    const api = rebuilt(transport, manifest, false)!;
    const seen = vi.fn();
    api.on('app.window-shown', seen);
    emit({ type: 'app.window-shown' });
    expect(seen).toHaveBeenCalledTimes(1);
    await expect(api.status.snapshot()).rejects.toMatchObject({ name: 'AgentDeckError', code: 'timeout' });
  });

  it('exposes a read-only globalThis.agentdeck', () => {
    expect(installAgentDeckApi(fakeTransport().transport, manifest, true)).toBeUndefined();
    const g = globalThis as unknown as { agentdeck: AgentDeckApi };
    expect(g.agentdeck.contractsVersion).toBe(CONTRACTS_VERSION);
    expect(Object.isFrozen(g.agentdeck)).toBe(true);
    expect(() => {
      'use strict';
      g.agentdeck = {} as AgentDeckApi;
    }).toThrow();
  });
});
