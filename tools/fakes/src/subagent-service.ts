// SubagentService 的假实现（MVP v3 · N10 · 后台 agent）：用 set 预置某个终端的后台 agent，用 setTranscript 预置记录。
// set 时发 subagents.changed；看着记录的改了发 subagents.transcript-changed。没预置过的终端不列，记录返回 no-data。

import type { BackgroundAgent, BackgroundAgentTranscript, SubagentService, TerminalBackgroundAgents, TerminalId, TranscriptLine } from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';

export interface FakeSubagentServiceOptions {
  bus?: FakeEventBus;
}

/** 一个后台 agent，没给的字段按“刚开始跑”填。 */
export function fakeBackgroundAgent(terminalId: TerminalId, patch: Partial<BackgroundAgent> & { id: string }): BackgroundAgent {
  return {
    terminalId,
    agentType: 'general-purpose',
    description: null,
    background: true,
    state: 'running',
    reason: null,
    startedAt: '2026-10-26T09:00:00.000Z',
    endedAt: null,
    durationMs: null,
    tokens: null,
    lastStep: null,
    current: true,
    ...patch,
  };
}

const key = (terminalId: TerminalId, agentId: string) => `${terminalId}\u0000${agentId}`;

export class FakeSubagentService implements SubagentService {
  private readonly bus: FakeEventBus;
  private readonly agents = new Map<TerminalId, BackgroundAgent[]>();
  private readonly transcripts = new Map<string, TranscriptLine[]>();
  /** 正在看记录的（终端 + agent）。 */
  readonly watching = new Set<string>();

  constructor(opts: FakeSubagentServiceOptions = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
  }

  async list(): Promise<TerminalBackgroundAgents[]> {
    return [...this.agents].filter(([, a]) => a.length > 0).map(([terminalId, agents]) => structuredClone({ terminalId, agents }));
  }

  async watchTranscript(terminalId: TerminalId, agentId: string): Promise<BackgroundAgentTranscript> {
    this.watching.add(key(terminalId, agentId));
    return this.transcript(terminalId, agentId);
  }

  async unwatchTranscript(terminalId: TerminalId, agentId: string): Promise<void> {
    this.watching.delete(key(terminalId, agentId));
  }

  /** 换掉一个终端的后台 agent（按开始的先后），发 subagents.changed。 */
  set(terminalId: TerminalId, agents: BackgroundAgent[]): void {
    this.agents.set(terminalId, agents);
    this.bus.emit({ type: 'subagents.changed', agents: structuredClone({ terminalId, agents }) });
  }

  /** 预置或换掉一个后台 agent 的记录；看着时发 subagents.transcript-changed。 */
  setTranscript(terminalId: TerminalId, agentId: string, lines: TranscriptLine[]): void {
    this.transcripts.set(key(terminalId, agentId), lines);
    if (this.watching.has(key(terminalId, agentId))) {
      this.bus.emit({ type: 'subagents.transcript-changed', transcript: this.transcript(terminalId, agentId) });
    }
  }

  private transcript(terminalId: TerminalId, agentId: string): BackgroundAgentTranscript {
    const lines = this.transcripts.get(key(terminalId, agentId));
    if (!lines?.length) return { terminalId, agentId, lines: [], omitted: 0, file: null, state: 'no-data', reason: 'No transcript yet' };
    return { terminalId, agentId, lines: structuredClone(lines), omitted: 0, file: `/fake/subagents/agent-${agentId}.jsonl`, state: 'ok', reason: null };
  }
}
