// SubagentService（MVP v3 · N10，画板 13，DR-61）：agent 自带的后台子 agent，按终端列出来，只读。
//
//   钩子（noteHook，组装时把 HookServer 收到的每一条都交进来）→ 谁开始了、谁做完了、你是不是发了新消息
//   → 子 agent 的 meta.json（任务描述、是不是后台）和记录 jsonl（JsonlTail 只读新增部分）→ 最近一步、token、记录窗口的行
//   → 有变化时 emit subagents.changed；有人看着记录时 emit subagents.transcript-changed
//
// 现在只有 claude（见 claude.ts）；别的 agent 的钩子直接忽略，界面就不挂提示（DR-61 调研后再加）。
// 不保存：重开应用后从空开始。只读用户数据，不改 agent 的任何文件。

import { readFile } from 'node:fs/promises';
import type {
  BackgroundAgent,
  BackgroundAgentTranscript,
  SubagentEvent,
  SubagentService,
  TerminalBackgroundAgents,
  TerminalId,
} from '@agentdeck/contracts';
import { JsonlTail } from '../usage/tail.ts';
import { obj, str } from '../usage/types.ts';
import {
  ClaudeTranscriptParser,
  claudeSubagentFile,
  claudeSubagentMetaFile,
  isClaudeSyntheticPrompt,
  parseClaudeBackgroundTasks,
  parseClaudeSubagentMeta,
  parseClaudeTaskNotification,
} from './claude.ts';

export const SUBAGENT_AGENTS = ['claude'] as const;

export interface SubagentServiceOptions {
  emit: (event: SubagentEvent) => void;
  /** 有子 agent 在跑、或有人看着记录时多久读一次，默认 1000。 */
  pollMs?: number;
  /** 钩子来了以后等多久再读（同一时刻常来好几条），默认 100。 */
  throttleMs?: number;
  now?: () => number;
}

interface AgentEntry {
  data: BackgroundAgent;
  file: string | null;
  metaRead: boolean;
  tail: JsonlTail | null;
  parser: ClaudeTranscriptParser;
  /** 做完时 agent 报了 token 数，不再用记录里算的。 */
  finalTokens: boolean;
  /** 看着记录窗口的次数（watchTranscript 减去 unwatchTranscript）。 */
  watchers: number;
  /** 钩子说有变化，下次刷新时读一遍记录（做完的子 agent 平时不读）。 */
  dirty: boolean;
  lastTranscriptJson: string | null;
}

interface TermEntry {
  terminalId: TerminalId;
  /** 主对话的记录文件（钩子负载的 transcript_path）。 */
  main: string | null;
  agents: Map<string, AgentEntry>;
  lastJson: string | null;
  busy: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 一个终端最多记这么多个子 agent，多了先丢最早做完的。 */
const MAX_AGENTS = 50;

export class SubagentServiceImpl implements SubagentService {
  private readonly terms = new Map<TerminalId, TermEntry>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly opts: SubagentServiceOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // ---- SubagentService ----

  async list(): Promise<TerminalBackgroundAgents[]> {
    return [...this.terms.values()].filter((t) => t.agents.size > 0).map((t) => this.snapshot(t));
  }

  async watchTranscript(terminalId: TerminalId, agentId: string): Promise<BackgroundAgentTranscript> {
    const t = this.terms.get(terminalId);
    const a = t?.agents.get(agentId);
    if (!t || !a) return emptyTranscript(terminalId, agentId, 'Unknown agent');
    a.watchers += 1;
    a.dirty = true;
    this.ensurePoller();
    await this.refresh(t);
    return this.transcript(t, a);
  }

  async unwatchTranscript(terminalId: TerminalId, agentId: string): Promise<void> {
    const a = this.terms.get(terminalId)?.agents.get(agentId);
    if (a) {
      a.watchers = Math.max(0, a.watchers - 1);
      if (a.watchers === 0) a.lastTranscriptJson = null;
    }
  }

  // ---- 组装用 ----

  /** 钩子。从不“吃掉”钩子：状态机、用量照常处理。 */
  noteHook(hook: { terminalId: TerminalId; agent: string; hookName: string; payload: unknown }): void {
    if (this.closed || hook.agent !== 'claude') return;
    const p = obj(hook.payload);
    if (!p) return;
    const known = this.terms.get(hook.terminalId);
    const main = str(p['transcript_path']);
    let changed = false;
    switch (hook.hookName) {
      case 'SubagentStart': {
        const id = str(p['agent_id']);
        if (!id) break;
        const t = this.term(hook.terminalId);
        const a = t.agents.get(id) ?? this.add(t, id);
        // 同一个子 agent 可以被主 agent 叫回来接着做（task-notification 里写着），这时重新算“在跑”
        a.data = { ...a.data, state: 'running', reason: null, endedAt: null, durationMs: null, current: true };
        a.data.agentType = a.data.agentType ?? str(p['agent_type']);
        a.dirty = true;
        changed = true;
        break;
      }
      case 'SubagentStop': {
        // 只认见过 SubagentStart 的：claude 自己的内部查询也会单独发 SubagentStop（没有 agent_type、没有 Start，
        // 2.1.291 实测每轮一两个），不是你能看见的子 agent
        const id = str(p['agent_id']);
        const a = id ? known?.agents.get(id) : undefined;
        if (!a) break;
        if (a.data.state === 'running') a.data = { ...a.data, state: 'done', endedAt: this.iso() };
        a.data.agentType = a.data.agentType ?? str(p['agent_type']);
        const file = str(p['agent_transcript_path']);
        if (file && file !== a.file) {
          a.file = file;
          a.tail = null;
          a.parser = new ClaudeTranscriptParser();
          a.metaRead = false;
        }
        a.dirty = true;
        changed = true;
        break;
      }
      case 'UserPromptSubmit': {
        if (!known) break;
        const prompt = str(p['prompt']) ?? '';
        const n = parseClaudeTaskNotification(prompt);
        if (n) {
          const a = known.agents.get(n.agentId);
          if (!a) break;
          const ok = !n.status || n.status === 'completed';
          a.data = {
            ...a.data,
            state: ok ? 'done' : 'failed',
            reason: ok ? null : capitalize(n.status!),
            endedAt: a.data.endedAt ?? this.iso(),
            durationMs: n.durationMs ?? a.data.durationMs,
            tokens: n.tokens ?? a.data.tokens,
          };
          if (n.tokens !== null) a.finalTokens = true;
          a.dirty = true;
          changed = true;
        } else if (!isClaudeSyntheticPrompt(prompt)) {
          // 你给主 agent 发了下一条消息：做完的不再算这一轮，小提示不再数它们
          for (const a of known.agents.values()) {
            if (a.data.state !== 'running' && a.data.current) {
              a.data = { ...a.data, current: false };
              changed = true;
            }
          }
        }
        break;
      }
      case 'SessionEnd': {
        if (!known) break;
        for (const a of known.agents.values()) {
          if (a.data.state === 'running') {
            a.data = { ...a.data, state: 'failed', reason: 'Session ended', endedAt: this.iso() };
            changed = true;
          }
        }
        break;
      }
    }
    const t = this.terms.get(hook.terminalId);
    if (!t) return;
    if (main && main !== t.main) {
      t.main = main;
      changed = true;
    }
    // Stop / SubagentStop 带着 background_tasks：任务描述先从这里补上（meta.json 可能还没写）
    for (const task of parseClaudeBackgroundTasks(p['background_tasks'])) {
      const a = t.agents.get(task.id);
      if (!a) continue;
      if (!a.data.description && task.description) {
        a.data = { ...a.data, description: task.description, background: a.data.background ?? true };
        changed = true;
      }
      if (!a.data.agentType && task.agentType) a.data = { ...a.data, agentType: task.agentType };
    }
    if (changed) this.schedule(t);
  }

  /** 终端关掉了：它的子 agent 都不要了。 */
  noteTerminalGone(terminalId: TerminalId): void {
    const t = this.terms.get(terminalId);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    this.terms.delete(terminalId);
    if (t.agents.size > 0 && !this.closed) this.opts.emit({ type: 'subagents.changed', agents: { terminalId, agents: [] } });
    this.stopPollerIfIdle();
  }

  close(): void {
    this.closed = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    for (const t of this.terms.values()) if (t.timer) clearTimeout(t.timer);
    this.terms.clear();
  }

  // ---- 内部 ----

  private term(terminalId: TerminalId): TermEntry {
    let t = this.terms.get(terminalId);
    if (!t) {
      t = { terminalId, main: null, agents: new Map(), lastJson: null, busy: Promise.resolve(), timer: null };
      this.terms.set(terminalId, t);
    }
    return t;
  }

  private add(t: TermEntry, id: string): AgentEntry {
    const a: AgentEntry = {
      data: {
        id,
        terminalId: t.terminalId,
        agentType: null,
        description: null,
        background: null,
        state: 'running',
        reason: null,
        startedAt: this.iso(),
        endedAt: null,
        durationMs: null,
        tokens: null,
        lastStep: null,
        current: true,
      },
      file: null,
      metaRead: false,
      tail: null,
      parser: new ClaudeTranscriptParser(),
      finalTokens: false,
      watchers: 0,
      dirty: true,
      lastTranscriptJson: null,
    };
    t.agents.set(id, a);
    if (t.agents.size > MAX_AGENTS) {
      const old = [...t.agents.values()].find((x) => x.data.state !== 'running' && x.watchers === 0);
      if (old) t.agents.delete(old.data.id);
    }
    this.ensurePoller();
    return a;
  }

  private active(a: AgentEntry): boolean {
    return a.data.state === 'running' || a.watchers > 0 || a.dirty || !a.metaRead;
  }

  private ensurePoller(): void {
    if (this.poller || this.closed) return;
    this.poller = setInterval(() => {
      for (const t of this.terms.values()) if ([...t.agents.values()].some((a) => this.active(a))) void this.refresh(t);
      this.stopPollerIfIdle();
    }, this.opts.pollMs ?? 1000);
    this.poller.unref?.();
  }

  private stopPollerIfIdle(): void {
    if (!this.poller) return;
    for (const t of this.terms.values()) for (const a of t.agents.values()) if (this.active(a)) return;
    clearInterval(this.poller);
    this.poller = null;
  }

  private schedule(t: TermEntry): void {
    if (t.timer || this.closed) return;
    t.timer = setTimeout(() => {
      t.timer = null;
      void this.refresh(t);
    }, this.opts.throttleMs ?? 100);
    t.timer.unref?.();
  }

  /** 同一个终端的刷新排队进行。 */
  private refresh(t: TermEntry): Promise<void> {
    t.busy = t.busy.then(() => this.doRefresh(t)).catch(() => undefined);
    return t.busy;
  }

  private async doRefresh(t: TermEntry): Promise<void> {
    for (const a of t.agents.values()) {
      if (!this.active(a)) continue;
      a.dirty = false;
      if (!a.file && t.main) a.file = claudeSubagentFile(t.main, a.data.id);
      if (!a.file) continue;
      if (!a.metaRead) {
        const meta = await readFile(claudeSubagentMetaFile(a.file), 'utf8').then(parseClaudeSubagentMeta, () => null);
        if (meta) {
          a.metaRead = true;
          a.data = {
            ...a.data,
            description: meta.description ?? a.data.description,
            agentType: meta.agentType ?? a.data.agentType,
            background: meta.background ?? a.data.background,
          };
        } else if (a.data.state !== 'running') {
          a.metaRead = true; // 做完了还没有 meta：不再找
        }
      }
      if (!a.tail) {
        const parser = new ClaudeTranscriptParser();
        a.parser = parser;
        a.tail = new JsonlTail(
          a.file,
          (line) => a.parser.feed(line),
          () => {
            a.parser = new ClaudeTranscriptParser();
          },
        );
      }
      await a.tail.poll();
      const snap = a.parser.snapshot();
      a.data = {
        ...a.data,
        lastStep: snap.lastStep ?? a.data.lastStep,
        tokens: a.finalTokens ? a.data.tokens : (snap.tokens ?? a.data.tokens),
      };
      if (a.watchers > 0 && !this.closed) {
        const transcript = this.transcript(t, a);
        const json = JSON.stringify(transcript);
        if (json !== a.lastTranscriptJson) {
          a.lastTranscriptJson = json;
          this.opts.emit({ type: 'subagents.transcript-changed', transcript });
        }
      }
    }
    if (this.terms.get(t.terminalId) !== t || this.closed) return;
    const snapshot = this.snapshot(t);
    const json = JSON.stringify(snapshot);
    if (json === t.lastJson) return;
    t.lastJson = json;
    this.opts.emit({ type: 'subagents.changed', agents: snapshot });
  }

  private snapshot(t: TermEntry): TerminalBackgroundAgents {
    return { terminalId: t.terminalId, agents: [...t.agents.values()].map((a) => ({ ...a.data })) };
  }

  private transcript(t: TermEntry, a: AgentEntry): BackgroundAgentTranscript {
    const snap = a.parser.snapshot();
    if (!a.file || snap.lines.length === 0) {
      return { ...emptyTranscript(t.terminalId, a.data.id, 'No transcript yet'), file: a.file };
    }
    return { terminalId: t.terminalId, agentId: a.data.id, lines: snap.lines, omitted: snap.omitted, file: a.file, state: 'ok', reason: null };
  }
}

function emptyTranscript(terminalId: TerminalId, agentId: string, reason: string): BackgroundAgentTranscript {
  return { terminalId, agentId, lines: [], omitted: 0, file: null, state: 'no-data', reason };
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
