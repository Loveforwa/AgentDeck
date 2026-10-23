// window.agentdeck 的实现：按方法名单生成通用代理。
//   api.<service>.<method>(...args) → bridge.invoke({ service, method, args })，返回 { error } 时抛 AgentDeckError
//   FIRE_AND_FORGET 里的方法 → bridge.send(...)，不等返回
//   on(type, listener) → 按 type 分发 IPC.event 上的事件
//   onTerminalData(listener) → 终端输出端口上的消息
//
// 为什么在页面世界里跑：contextBridge 只复制 Error 的 message，code / detail / name 都会丢。
// 所以 preload 只暴露最底层的 bridge，这个函数用 contextBridge.executeInMainWorld 在页面世界执行，
// AgentDeckError 在页面世界里构造。executeInMainWorld 会把函数序列化成源码，
// 因此函数体必须自包含：不能引用外部变量或 import，需要的数据全从参数传进来。

import type {
  AgentDeckApi,
  AgentDeckErrorData,
  AgentDeckEvent,
  FIRE_AND_FORGET,
  InvokeMessage,
} from '@agentdeck/contracts';
import type { SERVICE_METHODS } from '../shared/methods.ts';

/** preload（隔离世界）交给页面世界的最底层能力。 */
export interface RawBridge {
  /** 原样返回主进程的结果，包括 { error }。 */
  invoke(message: InvokeMessage): Promise<unknown>;
  send(message: InvokeMessage): void;
  /** 只调用一次。 */
  onEvent(listener: (event: AgentDeckEvent) => void): void;
  /** 只调用一次。 */
  onTerminalData(listener: (message: unknown) => void): void;
}

export interface ApiManifest {
  methods: typeof SERVICE_METHODS;
  fireAndForget: typeof FIRE_AND_FORGET;
  contractsVersion: string;
}

/** 构造 window.agentdeck。expose 为 true 时挂到 globalThis.agentdeck（只读）并返回 undefined。 */
export function installAgentDeckApi(bridge: RawBridge, manifest: ApiManifest, expose: boolean): AgentDeckApi | undefined {
  // ---- 以下全部自包含 ----
  class AgentDeckError extends Error {
    code: string;
    detail?: string;
    constructor(data: AgentDeckErrorData) {
      super(data.message);
      this.name = 'AgentDeckError';
      this.code = data.code;
      if (data.detail !== undefined) this.detail = data.detail;
    }
    toData(): AgentDeckErrorData {
      const data = { code: this.code, message: this.message } as AgentDeckErrorData;
      if (this.detail !== undefined) data.detail = this.detail;
      return data;
    }
  }

  // 和 shared/wire.ts 的 isErrorEnvelope 同一规则：只有 error 一个键，且形状是 AgentDeckErrorData。
  const errorOf = (value: unknown): AgentDeckErrorData | null => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'error') return null;
    const error = (value as { error: unknown }).error as { code?: unknown; message?: unknown } | null;
    return typeof error === 'object' && error !== null && typeof error.code === 'string' && typeof error.message === 'string'
      ? (error as AgentDeckErrorData)
      : null;
  };

  const callSafely = (listener: (payload: unknown) => void, payload: unknown): void => {
    try {
      listener(payload);
    } catch (err) {
      console.error('[agentdeck] listener failed', err);
    }
  };

  const api: Record<string, unknown> = {};
  for (const service of Object.keys(manifest.methods)) {
    const methods = (manifest.methods as Record<string, readonly string[]>)[service] ?? [];
    const fireAndForget = (manifest.fireAndForget as Record<string, readonly string[] | undefined>)[service] ?? [];
    const proxy: Record<string, unknown> = {};
    for (const method of methods) {
      const message = (args: unknown[]) => ({ service, method, args }) as InvokeMessage;
      proxy[method] = fireAndForget.includes(method)
        ? (...args: unknown[]): void => bridge.send(message(args))
        : async (...args: unknown[]): Promise<unknown> => {
            const result = await bridge.invoke(message(args));
            const error = errorOf(result);
            if (error !== null) throw new AgentDeckError(error);
            return result;
          };
    }
    api[service] = Object.freeze(proxy);
  }

  const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
  bridge.onEvent((event) => {
    const set = eventListeners.get(event.type);
    if (set !== undefined) for (const listener of [...set]) callSafely(listener, event);
  });
  api['on'] = (type: string, listener: (payload: unknown) => void) => {
    let set = eventListeners.get(type);
    if (set === undefined) eventListeners.set(type, (set = new Set()));
    const entry = (payload: unknown) => listener(payload);
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  };

  const dataListeners = new Set<(payload: unknown) => void>();
  bridge.onTerminalData((message) => {
    for (const listener of [...dataListeners]) callSafely(listener, message);
  });
  api['onTerminalData'] = (listener: (payload: unknown) => void) => {
    const entry = (payload: unknown) => listener(payload);
    dataListeners.add(entry);
    return () => {
      dataListeners.delete(entry);
    };
  };

  api['contractsVersion'] = manifest.contractsVersion;
  const result = Object.freeze(api) as unknown as AgentDeckApi;
  if (!expose) return result;
  Object.defineProperty(globalThis, 'agentdeck', { value: result, writable: false, configurable: false, enumerable: true });
  return undefined;
}
