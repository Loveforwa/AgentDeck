// 服务注册表：按 { service, method } 路由界面来的调用，异常统一转成 AgentDeckErrorData。
// 不 import Electron，方便单测；和 ipcMain 的连接在 ipc.ts。

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentDeckErrorData, ServiceName, Services } from '@agentdeck/contracts';
import { isFireAndForget, parseInvokeMessage, toErrorData, type ErrorEnvelope } from '../shared/wire.ts';

/** 一次调用来自哪个窗口。服务实现里用 registry.context() 取。 */
export interface InvokeContext {
  /** 发起调用的 webContents.id。 */
  senderId: number;
}

export interface ServiceRegistry {
  /** 可以只实现一部分方法；没实现的方法调用时返回 not-found。同名重复注册会抛错。 */
  register<S extends ServiceName>(name: S, impl: Partial<Services[S]>): void;
  /** 处理 IPC.invoke：成功返回结果，失败返回 { error }，不会抛。 */
  invoke(raw: unknown, ctx: InvokeContext): Promise<unknown>;
  /** 处理 IPC.send：只接受 FIRE_AND_FORGET 里的方法，错误交给 onError。 */
  send(raw: unknown, ctx: InvokeContext): void;
  /** 当前调用的上下文；不在调用里时为 undefined。异步链里也能取到。 */
  context(): InvokeContext | undefined;
  has(name: string): boolean;
}

export interface RegistryOptions {
  /** fire-and-forget 调用出错时调用。默认 console.error。 */
  onError?: (error: AgentDeckErrorData, raw: unknown) => void;
}

type Method = (...args: unknown[]) => unknown;

export function createServiceRegistry(options: RegistryOptions = {}): ServiceRegistry {
  const services = new Map<string, object>();
  const storage = new AsyncLocalStorage<InvokeContext>();
  const onError = options.onError ?? ((error) => console.error('[agentdeck:send]', error));

  function resolve(raw: unknown): { fn: Method; self: object; args: unknown[] } | AgentDeckErrorData {
    const msg = parseInvokeMessage(raw);
    if (!('service' in msg)) return msg;
    const impl = services.get(msg.service);
    if (impl === undefined) {
      return { code: 'not-found', message: `Service not available: ${msg.service}` };
    }
    // 不允许调到 Object.prototype 上的东西（constructor、__proto__、toString……）。
    const fn = msg.method in Object.prototype ? undefined : (impl as Record<string, unknown>)[msg.method];
    if (typeof fn !== 'function') {
      return { code: 'not-found', message: `Method not available: ${msg.service}.${msg.method}` };
    }
    return { fn: fn as Method, self: impl, args: msg.args };
  }

  return {
    register(name, impl) {
      if (services.has(name)) throw new Error(`Service already registered: ${name}`);
      services.set(name, impl);
    },

    async invoke(raw, ctx) {
      const target = resolve(raw);
      if (!('fn' in target)) return { error: target } satisfies ErrorEnvelope;
      try {
        return await storage.run(ctx, () => target.fn.apply(target.self, target.args));
      } catch (err) {
        return { error: toErrorData(err) } satisfies ErrorEnvelope;
      }
    },

    send(raw, ctx) {
      const msg = parseInvokeMessage(raw);
      if ('service' in msg && !isFireAndForget(msg.service, msg.method)) {
        onError({ code: 'invalid-argument', message: `Not a fire-and-forget method: ${msg.service}.${msg.method}` }, raw);
        return;
      }
      const target = resolve(raw);
      if (!('fn' in target)) {
        onError(target, raw);
        return;
      }
      try {
        const result = storage.run(ctx, () => target.fn.apply(target.self, target.args));
        if (result instanceof Promise) result.catch((err: unknown) => onError(toErrorData(err), raw));
      } catch (err) {
        onError(toErrorData(err), raw);
      }
    },

    context: () => storage.getStore(),
    has: (name) => services.has(name),
  };
}
