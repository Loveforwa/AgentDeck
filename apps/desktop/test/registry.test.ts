import { describe, expect, it, vi } from 'vitest';
import { AgentDeckError, type AgentDeckErrorData } from '@agentdeck/contracts';
import { createServiceRegistry } from '../src/main/registry.ts';

const ctx = { senderId: 7 };

describe('service registry: routing', () => {
  it('routes { service, method, args } to the registered implementation', async () => {
    const registry = createServiceRegistry();
    const list = vi.fn(async () => ['a'] as never);
    registry.register('projects', { list });
    registry.register('workspaces', { list: async () => ['b'] as never });

    expect(await registry.invoke({ service: 'projects', method: 'list', args: [] }, ctx)).toEqual(['a']);
    expect(await registry.invoke({ service: 'workspaces', method: 'list', args: [] }, ctx)).toEqual(['b']);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('passes args and keeps `this` bound to the implementation', async () => {
    const registry = createServiceRegistry();
    class Git {
      prefix = 'repo:';
      async repoRoot(dir: string) {
        return this.prefix + dir;
      }
    }
    registry.register('git', new Git());
    expect(await registry.invoke({ service: 'git', method: 'repoRoot', args: ['/x'] }, ctx)).toBe('repo:/x');
  });

  it('returns not-found for unknown services, methods and prototype members', async () => {
    const registry = createServiceRegistry();
    registry.register('board', { load: async () => ({}) as never });
    for (const [service, method] of [
      ['projects', 'list'],
      ['board', 'save'],
      ['board', 'constructor'],
      ['board', 'toString'],
      ['board', '__proto__'],
    ]) {
      const result = (await registry.invoke({ service, method, args: [] }, ctx)) as { error: AgentDeckErrorData };
      expect(result.error.code).toBe('not-found');
    }
  });

  it('rejects malformed messages with invalid-argument', async () => {
    const registry = createServiceRegistry();
    for (const raw of [null, 'x', { service: 'app' }, { service: 'app', method: 'quit', args: 'no' }]) {
      expect(await registry.invoke(raw, ctx)).toEqual({ error: expect.objectContaining({ code: 'invalid-argument' }) });
    }
  });

  it('refuses duplicate registration', () => {
    const registry = createServiceRegistry();
    registry.register('status', {});
    expect(() => registry.register('status', {})).toThrow(/already registered/);
  });

  it('exposes the caller context inside async implementations', async () => {
    const registry = createServiceRegistry();
    registry.register('status', {
      snapshot: async () => {
        await Promise.resolve();
        return [registry.context()?.senderId] as never;
      },
    });
    expect(await registry.invoke({ service: 'status', method: 'snapshot', args: [] }, ctx)).toEqual([7]);
    expect(registry.context()).toBeUndefined();
  });
});

describe('service registry: errors', () => {
  const invokeThrowing = async (thrown: unknown) => {
    const registry = createServiceRegistry();
    registry.register('git', {
      status: async () => {
        throw thrown;
      },
    });
    return registry.invoke({ service: 'git', method: 'status', args: ['/r'] }, ctx);
  };

  it('converts AgentDeckError into its data', async () => {
    const err = new AgentDeckError({ code: 'git-failed', message: 'git status failed', detail: 'fatal: x' });
    expect(await invokeThrowing(err)).toEqual({
      error: { code: 'git-failed', message: 'git status failed', detail: 'fatal: x' },
    });
  });

  it('passes through plain AgentDeckErrorData objects', async () => {
    expect(await invokeThrowing({ code: 'timeout', message: 'Timed out', extra: 1 })).toEqual({
      error: { code: 'timeout', message: 'Timed out' },
    });
  });

  it('turns other errors into internal, keeping the stack as detail', async () => {
    const result = (await invokeThrowing(new TypeError('boom'))) as { error: AgentDeckErrorData };
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toBe('boom');
    expect(result.error.detail).toContain('TypeError: boom');
    expect(await invokeThrowing('oops')).toEqual({ error: { code: 'internal', message: 'oops' } });
  });

  it('catches synchronous throws too', async () => {
    const registry = createServiceRegistry();
    registry.register('git', {
      status: (() => {
        throw new AgentDeckError({ code: 'not-a-git-repo', message: 'Not a git repository' });
      }) as never,
    });
    expect(await registry.invoke({ service: 'git', method: 'status', args: [] }, ctx)).toEqual({
      error: { code: 'not-a-git-repo', message: 'Not a git repository' },
    });
  });
});

describe('service registry: fire-and-forget', () => {
  it('calls FIRE_AND_FORGET methods with the caller context', () => {
    const registry = createServiceRegistry();
    const seen: unknown[] = [];
    registry.register('terminals', {
      write: (viewId, data) => {
        seen.push([viewId, data, registry.context()?.senderId]);
      },
    });
    registry.send({ service: 'terminals', method: 'write', args: ['v1', 'ls\r'] }, ctx);
    expect(seen).toEqual([['v1', 'ls\r', 7]]);
  });

  it('reports errors to onError instead of throwing', async () => {
    const onError = vi.fn();
    const registry = createServiceRegistry({ onError });
    registry.register('terminals', {
      write: () => {
        throw new AgentDeckError({ code: 'not-found', message: 'No such view' });
      },
      resize: (async () => {
        throw new Error('async boom');
      }) as never,
    });
    expect(() => registry.send({ service: 'terminals', method: 'write', args: [] }, ctx)).not.toThrow();
    registry.send({ service: 'terminals', method: 'resize', args: [] }, ctx);
    registry.send({ service: 'app', method: 'setBadge', args: [1] }, ctx); // 未注册
    await new Promise((r) => setTimeout(r, 0));
    expect(onError.mock.calls.map(([e]) => (e as AgentDeckErrorData).code)).toEqual(['not-found', 'not-found', 'internal']);
  });

  it('refuses methods that are not fire-and-forget', () => {
    const onError = vi.fn();
    const registry = createServiceRegistry({ onError });
    const kill = vi.fn();
    registry.register('terminals', { kill });
    registry.send({ service: 'terminals', method: 'kill', args: ['t1'] }, ctx);
    expect(kill).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid-argument' }), expect.anything());
  });
});
