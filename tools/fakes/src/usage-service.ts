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
    limit: null,
  };
}

export class FakeUsageService implements UsageService {
  private readonly bus: FakeEventBus;
  private readonly usage = new Map<TerminalId, TerminalUsage>();
  /** 正在 watch 的终端（有任何一个 owner 在看）。 */
  readonly watching = new Set<TerminalId>();
  /** 每个终端谁在看（PL3 起 watch 可以带 owner）。 */
  private readonly owners = new Map<TerminalId, Set<string>>();

  constructor(opts: FakeUsageServiceOptions = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
  }

  async get(terminalId: TerminalId): Promise<TerminalUsage> {
    return structuredClone(this.usage.get(terminalId) ?? emptyUsage(terminalId));
  }

  async watch(terminalId: TerminalId, owner = 'default'): Promise<TerminalUsage> {
    const set = this.owners.get(terminalId) ?? new Set<string>();
    set.add(owner);
    this.owners.set(terminalId, set);
    this.watching.add(terminalId);
    return this.get(terminalId);
  }

  async unwatch(terminalId: TerminalId, owner = 'default'): Promise<void> {
    const set = this.owners.get(terminalId);
    set?.delete(owner);
    if (set && set.size > 0) return;
    this.owners.delete(terminalId);
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
