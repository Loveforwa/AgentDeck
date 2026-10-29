// SessionService 的假实现（M9 · SE0）：内存里的 Session 表。每次变化发 session.changed。
// 控制方法：open（新建一条）、stop、reopen、addSegment，以及 playLeadScenario 回放
// “Lead 开 3 个子 session → 关掉 Lead → Reopen → 交接”。

import type {
  AbsPath,
  AgentKind,
  AgentSessionId,
  AgentSessionReason,
  HandoffRequest,
  HandoffResult,
  Session,
  SessionId,
  SessionListOptions,
  SessionOrigin,
  SessionService,
  TerminalId,
  WorkspaceId,
} from '@agentdeck/contracts';
import type { FakeAgentService } from './agent-service.ts';
import { FakeEventBus } from './bus.ts';
import { clone, fail, idGenerator, nowIso } from './util.ts';

export interface FakeSessionServiceOptions {
  bus?: FakeEventBus;
  /** 给了就由它开 handoff 的终端（和真实现一样经过 agents.start）；不给时编一个终端 id。 */
  agents?: FakeAgentService;
}

export interface FakeSessionInit {
  agent: AgentKind;
  cwd: AbsPath;
  workspaceId?: WorkspaceId | null;
  parentId?: SessionId | null;
  origin?: SessionOrigin;
  label?: string | null;
  title?: string | null;
  /** 不给时编一个；null 是建好就是 stopped。 */
  terminalId?: TerminalId | null;
  agentSessionId?: AgentSessionId;
}

export class FakeSessionService implements SessionService {
  readonly bus: FakeEventBus;
  private readonly agents: FakeAgentService | undefined;
  private readonly sessions = new Map<SessionId, Session>();
  private readonly nextId = idGenerator();
  /** 每个 Session 建的顺序，list 新的在前、children 按先后都按它排（同一毫秒里建的也分得清）。 */
  private readonly order = new Map<SessionId, number>();

  constructor(opts: FakeSessionServiceOptions = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
    this.agents = opts.agents;
  }

  async list(opts: SessionListOptions = {}): Promise<Session[]> {
    return clone(
      [...this.sessions.values()]
        .filter((s) => opts.workspaceId === undefined || s.workspaceId === opts.workspaceId)
        .filter((s) => opts.state === undefined || s.state === opts.state)
        .sort((a, b) => this.rank(b) - this.rank(a)),
    );
  }

  async get(id: SessionId): Promise<Session> {
    return clone(this.require(id));
  }

  async children(id: SessionId): Promise<Session[]> {
    this.require(id);
    return clone(
      [...this.sessions.values()].filter((s) => s.parentId === id).sort((a, b) => this.rank(a) - this.rank(b)),
    );
  }

  async rename(id: SessionId, label: string | null): Promise<Session> {
    const s = this.require(id);
    s.label = label === null || label.trim() === '' ? null : label.trim();
    return this.changed(s);
  }

  async handoff(req: HandoffRequest): Promise<HandoffResult> {
    const from = this.require(req.from);
    const origin: SessionOrigin = { kind: 'handoff' };
    let terminalId: TerminalId;
    let cmd = req.agent;
    let args: string[] = [];
    if (this.agents) {
      const started = await this.agents.start({
        agent: req.agent,
        cwd: from.cwd,
        workspaceId: from.workspaceId,
        mode: { kind: 'new' },
        prompt: req.note,
        parent: from.id,
        origin,
        ...(req.size ? { size: req.size } : {}),
      });
      terminalId = started.terminalId;
      cmd = started.cmd;
      args = started.args;
    } else {
      terminalId = this.nextId<TerminalId>('term-handoff');
    }
    const next = this.create({
      agent: req.agent,
      cwd: from.cwd,
      workspaceId: from.workspaceId,
      parentId: from.id,
      origin,
      terminalId,
    });
    next.handoffNote = req.note;
    from.state = 'handed-off';
    from.handedOffTo = next.id;
    this.changed(from);
    return { session: this.changed(next), terminalId, cmd, args };
  }

  async handoffSummary(id: SessionId): Promise<string> {
    const s = this.require(id);
    const last = s.agentSessions.at(-1);
    return [
      `Goal: continue ${s.label ?? s.title ?? 'this work'}.`,
      `Working directory: ${s.cwd}`,
      last ? `Previous conversation: ${s.agent} session ${last.id}` : `Previous agent: ${s.agent}`,
    ].join('\n');
  }

  // ---- 假实现专用 ----

  /** 新建一条 Session（像 agents.start 那样），发 session.changed。 */
  open(init: FakeSessionInit): Session {
    return this.changed(this.create(init));
  }

  /** 进程没了（关窗口、退出）：state 改 stopped、terminalId 清掉。handed-off 的保持 handed-off。 */
  stop(id: SessionId): Session {
    const s = this.require(id);
    s.terminalId = null;
    if (s.state === 'running') s.state = 'stopped';
    return this.changed(s);
  }

  /** Reopen：开回同一条，换一个新的终端，名字、父子都不变。 */
  reopen(id: SessionId, terminalId?: TerminalId): Session {
    const s = this.require(id);
    s.terminalId = terminalId ?? this.nextId<TerminalId>('term-reopen');
    s.state = 'running';
    s.handedOffTo = null;
    const last = s.agentSessions.at(-1);
    if (last) s.agentSessions.push({ id: last.id, startedAt: nowIso(), reason: 'resume' });
    return this.changed(s);
  }

  /** 多一段对话（/clear、compact……）。 */
  addSegment(id: SessionId, agentSessionId: AgentSessionId, reason: AgentSessionReason): Session {
    const s = this.require(id);
    s.agentSessions.push({ id: agentSessionId, startedAt: nowIso(), reason });
    return this.changed(s);
  }

  /**
   * 回放 S0 / S1 的流程：claude Lead 用 open_terminals 开 3 个 codex 子 session，关掉 Lead（子 session 不受影响），
   * Reopen Lead（开回同一条），再把第 1 个子 session 交接给 claude。
   */
  async playLeadScenario(opts: { cwd?: AbsPath; workspaceId?: WorkspaceId | null } = {}): Promise<{
    lead: SessionId;
    children: SessionId[];
    handoff: HandoffResult;
  }> {
    const cwd = opts.cwd ?? '/Users/you/code/app';
    const workspaceId = opts.workspaceId ?? null;
    const lead = this.open({ agent: 'claude', cwd, workspaceId, label: 'lead', agentSessionId: 'lead-conv-1' as AgentSessionId });
    const children = ['api', 'ui', 'docs'].map(
      (label) =>
        this.open({
          agent: 'codex',
          cwd,
          workspaceId,
          parentId: lead.id,
          origin: { kind: 'spawn', tool: 'open_terminals' },
          label,
        }).id,
    );
    this.stop(lead.id);
    this.reopen(lead.id);
    const first = children[0];
    if (first === undefined) fail('internal', 'No child session');
    const handoff = await this.handoff({ from: first, agent: 'claude', note: await this.handoffSummary(first) });
    return { lead: lead.id, children, handoff };
  }

  private create(init: FakeSessionInit): Session {
    const id = this.nextId<SessionId>('session');
    const at = nowIso();
    const terminalId = init.terminalId === undefined ? this.nextId<TerminalId>('term') : init.terminalId;
    const s: Session = {
      id,
      agent: init.agent,
      workspaceId: init.workspaceId ?? null,
      cwd: init.cwd,
      parentId: init.parentId ?? null,
      origin: init.origin ?? { kind: 'user' },
      label: init.label ?? null,
      title: init.title ?? null,
      agentSessions: init.agentSessionId ? [{ id: init.agentSessionId, startedAt: at, reason: 'start' }] : [],
      terminalId,
      state: terminalId === null ? 'stopped' : 'running',
      handedOffTo: null,
      handoffNote: null,
      createdAt: at,
      updatedAt: at,
    };
    this.sessions.set(id, s);
    this.order.set(id, this.order.size);
    return s;
  }

  private changed(s: Session): Session {
    s.updatedAt = nowIso();
    this.bus.emit({ type: 'session.changed', session: clone(s) });
    return clone(s);
  }

  private rank(s: Session): number {
    return this.order.get(s.id) ?? 0;
  }

  private require(id: SessionId): Session {
    const s = this.sessions.get(id);
    if (!s) fail('not-found', 'Session not found');
    return s;
  }
}
