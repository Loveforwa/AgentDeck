// UsageService 的假实现（插件 PL2 · Usage）：用 set 预置某个终端的用量，watch 着的终端改了就发 usage.changed。
// 没预置过的终端返回 no-data（"No session file yet"），和真实现读不到文件时一样。

import type { TerminalId, TerminalUsage, UsageService } from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';

export interface FakeUsageServiceOptions {
  bus?: FakeEventBus;
}

export function emptyUsage(terminalId: TerminalId, reason = 'No session file yet'): TerminalUsage {
  return {
    terminalId,
    agent: null,
    state: 'no-data',
    reason,
    sessionId: null,
    match: null,
    file: null,
    model: null,
    total: null,
    last: null,
    requests: 0,
    context: null,
    rateLimits: null,
    updatedAt: null,
  };
}

export class FakeUsageService implements UsageService {
  private readonly bus: FakeEventBus;
  private readonly usage = new Map<TerminalId, TerminalUsage>();
  /** 正在 watch 的终端。 */
  readonly watching = new Set<TerminalId>();

  constructor(opts: FakeUsageServiceOptions = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
  }

  async get(terminalId: TerminalId): Promise<TerminalUsage> {
    return structuredClone(this.usage.get(terminalId) ?? emptyUsage(terminalId));
  }

  async watch(terminalId: TerminalId): Promise<TerminalUsage> {
    this.watching.add(terminalId);
    return this.get(terminalId);
  }

  async unwatch(terminalId: TerminalId): Promise<void> {
    this.watching.delete(terminalId);
  }

  /** 预置或更新用量（patch 合并到当前值上）；watch 着时发 usage.changed。 */
  set(terminalId: TerminalId, patch: Partial<TerminalUsage>): TerminalUsage {
    const next: TerminalUsage = { ...(this.usage.get(terminalId) ?? emptyUsage(terminalId)), ...patch, terminalId };
    this.usage.set(terminalId, next);
    if (this.watching.has(terminalId)) this.bus.emit({ type: 'usage.changed', usage: structuredClone(next) });
    return next;
  }
}
