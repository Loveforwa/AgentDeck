// 各假实现共用的小工具：id、时间、拷贝、错误、ANSI 处理。

import { AgentDeckError } from '@agentdeck/contracts';
import type { ErrorCode, IsoTime } from '@agentdeck/contracts';

export function nowIso(): IsoTime {
  return new Date().toISOString();
}

/** 按前缀递增的 id 生成器，同一个实例里不重复，便于测试里断言。 */
export function idGenerator(): <T extends string>(prefix: string) => T {
  const counters = new Map<string, number>();
  return <T extends string>(prefix: string): T => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}-${n}` as T;
  };
}

/** 模拟跨进程边界：返回给调用方的数据都是拷贝，界面改了也不影响假实现内部状态。 */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function fail(code: ErrorCode, message: string, detail?: string): never {
  throw new AgentDeckError(detail === undefined ? { code, message } : { code, message, detail });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// CSI、OSC 和其余两字节转义序列。
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * 把原始输出变成纯文本行，近似 tmux capture-pane：去掉转义序列，
 * 行内的 \r 表示回到行首覆盖，只保留最后一段。
 */
export function toPlainLines(raw: string): string[] {
  const lines = stripAnsi(raw).replace(/\r\n/g, '\n').split('\n');
  return lines.map((line) => {
    const parts = line.split('\r');
    return parts[parts.length - 1] ?? '';
  });
}

/** path 等于 target，或 target 是 path 的上级目录。 */
export function isSameOrInside(path: string, target: string): boolean {
  return path === target || path.startsWith(target.endsWith('/') ? target : `${target}/`);
}

export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function slug(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
}

/** 把实例原型上的方法绑到实例上，这样 `const { write } = api.terminals` 也能用（和真 preload 一样）。 */
export function bindMethods<T extends object>(instance: T): T {
  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc && typeof desc.value === 'function' && !Object.prototype.hasOwnProperty.call(instance, key)) {
        Object.defineProperty(instance, key, { value: desc.value.bind(instance), configurable: true, writable: true });
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return instance;
}
