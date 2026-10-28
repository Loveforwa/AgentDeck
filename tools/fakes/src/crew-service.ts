// CrewService 的假实现（M8 · CR0 / CR13）：内存里的集群、任务表、关卡、子 session 表、Decisions、收件箱条目。
// 不开真的 worktree、不跑检查命令：check 按 setCheck 预置的结果回，merge 按 setConflict 预置的冲突回。
// 控制方法：setSessionStatus、addTask、setTaskStatus、setCheck、setConflict；
// 回放：playTemplateRun（模板模式从开始到合回 main）、playFreeRun（自由模式 Lead 开子 session 到 Ready to merge）；
// cli(caller, req) 按 contracts 的 cliCommandAllowed 放行，回 CliResponse。

import { AgentDeckError, cliCommandAllowed, isAgentDeckErrorData, parseCliCommand } from '@agentdeck/contracts';
import type {
  AgentKind,
  CliRequest,
  CliResponse,
  CreateCrewRequest,
  Crew,
  CrewCheckResult,
  CrewDecision,
  CrewGate,
  CrewGateKind,
  CrewId,
  CrewMembership,
  CrewMergeResult,
  CrewService,
  CrewSession,
  CrewSessionRef,
  CrewSessionStatus,
  CrewSpawnRequest,
  CrewStatus,
  CrewTask,
  CrewTaskId,
  CrewTaskStatus,
  CrewWaitRequest,
  CrewWaitResult,
  InboxItem,
  InboxItemId,
  InboxSource,
  IsoTime,
  ProjectId,
  SessionId,
  TerminalId,
} from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';
import type { FakeSessionService } from './session-service.ts';
import { clone, fail, idGenerator, nowIso } from './util.ts';

export interface FakeCrewServiceOptions {
  bus?: FakeEventBus;
  /** 给了就在里面建 Lead 和子 session 的 Session（parentId、origin crew），像真实现一样。 */
  sessions?: FakeSessionService;
  /** 集群的 worktree 放在哪，默认 /Users/you/.agentdeck/worktrees。 */
  worktreeRoot?: string;
}

interface CrewRecord {
  crew: Crew;
  tasks: CrewTask[];
  sessions: CrewSession[];
  gates: CrewGate[];
  decisions: CrewDecision[];
  notes: { by: string; text: string; at: IsoTime }[];
  leadTerminal: TerminalId;
}

/** session wait 认为“停下来了”的状态。 */
const STOPPED: readonly CrewSessionStatus[] = ['idle', 'needs-you', 'error', 'exited', 'limited'];

export class FakeCrewService implements CrewService {
  readonly bus: FakeEventBus;
  /** 收件箱里的条目（ask、关卡、Ready to merge）。收件箱的服务是 CR1，这里只记下来给测试和界面演示看。 */
  readonly inbox: InboxItem[] = [];
  /** send 发出去的消息。 */
  readonly sent: { sessionId: SessionId; text: string }[] = [];
  private readonly sessionsSvc: FakeSessionService | undefined;
  private readonly root: string;
  private readonly crews = new Map<CrewId, CrewRecord>();
  private readonly members = new Map<TerminalId, CrewMembership>();
  private readonly terminalOf = new Map<SessionId, TerminalId>();
  private readonly checks = new Map<string, CrewCheckResult>();
  private readonly conflicts = new Map<string, string[]>();
  private readonly nextId = idGenerator();

  constructor(opts: FakeCrewServiceOptions = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
    this.sessionsSvc = opts.sessions;
    this.root = opts.worktreeRoot ?? '/Users/you/.agentdeck/worktrees';
  }

  // ---- 界面用 ----

  async create(req: CreateCrewRequest): Promise<Crew> {
    if (!req.name.trim()) fail('invalid-argument', 'Crew name is empty');
    if (req.mode === 'free' && !req.free) fail('invalid-argument', 'A crew without a template needs its free-mode settings');
    if (req.mode === 'template' && !req.template) fail('invalid-argument', 'Pick a template');
    if ([...this.crews.values()].some((r) => r.crew.name === req.name && r.crew.projectId === req.projectId)) {
      fail('invalid-argument', `A crew named “${req.name}” already exists`);
    }
    const id = this.nextId<CrewId>('crew');
    const at = nowIso();
    const leadAgent = req.roles.find((r) => r.role === 'lead')?.agents[0] ?? 'claude';
    const leadTerminal = this.nextId<TerminalId>('term-lead');
    const leadSession = this.openSession(leadAgent, `${this.root}/${req.name}`, null, { crewId: id, role: 'lead' }, 'lead', leadTerminal);
    const askMe = new Set<CrewGateKind>(req.askMe);
    for (const always of req.mode === 'free' ? (['lead-ask', 'locked-path', 'merge-into-main'] as const) : (['stuck', 'merge-into-main'] as const)) {
      askMe.add(always);
    }
    const crew: Crew = {
      id,
      name: req.name,
      projectId: req.projectId,
      workspaceId: null,
      mode: req.mode,
      template: req.mode === 'template' ? (req.template ?? null) : null,
      goal: req.goal,
      branch: `crew/${req.name}`,
      baseBranch: req.baseBranch,
      roles: clone(req.roles),
      check: req.check ?? null,
      limits: clone(req.limits),
      askMe: [...askMe],
      leadMay: req.leadMay ?? { suggest: true, answer: false },
      free: req.mode === 'free' ? clone(req.free ?? null) : null,
      state: req.mode === 'template' ? 'planning' : 'running',
      stage: req.mode === 'template' ? 'Plan' : null,
      leadSession,
      createdAt: at,
      updatedAt: at,
    };
    this.crews.set(id, { crew, tasks: [], sessions: [], gates: [], decisions: [], notes: [], leadTerminal });
    this.members.set(leadTerminal, { crewId: id, mode: req.mode, role: 'lead', sessionId: leadSession, taskId: null });
    this.terminalOf.set(leadSession, leadTerminal);
    return this.crewChanged(id);
  }

  async list(projectId?: ProjectId): Promise<Crew[]> {
    return clone([...this.crews.values()].map((r) => r.crew).filter((c) => projectId === undefined || c.projectId === projectId));
  }

  async get(id: CrewId): Promise<Crew> {
    return clone(this.require(id).crew);
  }

  async pause(id: CrewId): Promise<Crew> {
    return this.setState(id, 'paused');
  }

  async resume(id: CrewId): Promise<Crew> {
    const r = this.require(id);
    if (r.crew.state !== 'paused') fail('invalid-argument', 'The crew is not paused');
    return this.setState(id, r.crew.mode === 'template' && r.tasks.length === 0 ? 'planning' : 'running');
  }

  async stop(id: CrewId): Promise<Crew> {
    const r = this.require(id);
    for (const s of r.sessions) if (s.status !== 'closed') this.updateSession(s, { status: 'closed', closedAt: nowIso() }, 'crew.session-closed');
    return this.setState(id, 'stopped');
  }

  async tasks(id: CrewId): Promise<CrewTask[]> {
    return clone(this.require(id).tasks);
  }

  async sessions(id: CrewId): Promise<CrewSession[]> {
    return clone(this.require(id).sessions);
  }

  async gates(id: CrewId, opts: { open?: boolean } = {}): Promise<CrewGate[]> {
    return clone(this.require(id).gates.filter((g) => !opts.open || g.resolved === null));
  }

  async resolveGate(gateId: string, decision: { approved: boolean; note?: string | null }): Promise<CrewGate> {
    const r = [...this.crews.values()].find((x) => x.gates.some((g) => g.id === gateId));
    const gate = r?.gates.find((g) => g.id === gateId);
    if (!r || !gate) fail('not-found', 'Gate not found');
    if (gate.resolved) fail('invalid-argument', 'This gate was already handled');
    const at = nowIso();
    gate.resolved = { approved: decision.approved, note: decision.note ?? null, at };
    const answer = decision.approved ? 'approved' : 'rejected';
    this.resolveInbox(gate.inboxItem, answer);
    this.addDecision(r, { id: gate.id, title: gateTitle(gate.kind) }, gate.taskId ? `${gate.taskId}` : 'Lead', gate.summary, answer, 'user');
    this.bus.emit({ type: 'crew.gate-changed', gate: clone(gate) });
    if (decision.approved && gate.kind === 'approve-plan') {
      r.crew.state = 'running';
      r.crew.stage = 'Build';
      for (const t of r.tasks) if (t.needs.length === 0) this.setTask(t, 'ready');
      this.crewChanged(r.crew.id);
    }
    if (decision.approved && gate.kind === 'merge-into-main') this.setState(r.crew.id, 'merged');
    return clone(gate);
  }

  async digest(crewId: CrewId, since?: IsoTime): Promise<string> {
    const r = this.require(crewId);
    const c = r.crew;
    const merged = r.tasks.filter((t) => t.status === 'merged').length;
    const lines = [
      `Crew ${c.name} · ${c.template ?? 'No template'} · started ${c.createdAt}`,
      `Goal: ${c.goal}`,
      c.mode === 'template'
        ? `Stage: ${c.stage ?? c.state} · ${merged} of ${r.tasks.length} merged`
        : `Subagents: ${r.sessions.filter((s) => s.status !== 'closed').length} open · ${r.sessions.filter((s) => s.mergedAt).length} merged`,
    ];
    if (r.tasks.length > 0) lines.push('Tasks', ...r.tasks.map((t) => `${t.id}  ${t.status}`));
    if (r.sessions.length > 0) lines.push('Sessions', ...r.sessions.map((s) => `${s.label}  ${s.agent}  ${s.status}${s.mergedAt ? ' · merged' : ''}`));
    const decisions = r.decisions.filter((d) => since === undefined || d.at > since);
    if (decisions.length > 0) lines.push('Decisions (newest last)', ...decisions.map((d) => `${d.item.title} · ${d.by}: ${d.answer}`));
    const notes = r.notes.filter((n) => since === undefined || n.at > since);
    if (notes.length > 0) lines.push('Notes', ...notes.map((n) => `${n.by}: ${n.text}`));
    return lines.join('\n');
  }

  async decisions(crewId: CrewId): Promise<CrewDecision[]> {
    return clone(this.require(crewId).decisions);
  }

  async membership(terminalId: TerminalId): Promise<CrewMembership | null> {
    return clone(this.members.get(terminalId) ?? null);
  }

  // ---- 命令行替终端调 ----

  async status(caller: TerminalId, opts: { since?: IsoTime } = {}): Promise<CrewStatus> {
    const r = this.crewOf(caller);
    return {
      crew: clone(r.crew),
      tasks: clone(r.tasks),
      sessions: clone(r.sessions),
      slots: { used: this.openSubs(r).length, max: this.maxAtOnce(r) },
      digest: await this.digest(r.crew.id, opts.since),
    };
  }

  async spawn(caller: TerminalId, req: CrewSpawnRequest): Promise<CrewSession> {
    const r = this.leadCrew(caller, 'open sessions');
    const free = r.crew.free;
    const allowed = free?.allowedAgents ?? r.crew.roles.flatMap((x) => x.agents);
    if (!allowed.includes(req.agent)) {
      fail('invalid-argument', `Refused: ${req.agent} isn’t allowed in this crew. Allowed: ${allowed.join(', ')}.`);
    }
    const open = this.openSubs(r);
    const max = this.maxAtOnce(r);
    if (open.length >= max) {
      fail('invalid-argument', `Refused: ${max} of ${max} subagents are running (${open.map((s) => s.label).join(', ')}). Close one or wait.`);
    }
    if (!/^[\w.-]+$/.test(req.label) || r.sessions.some((s) => s.label === req.label)) {
      fail('invalid-argument', `Refused: the label “${req.label}” is taken or not a plain name`);
    }
    const worktree = req.worktree ?? (free?.ownWorktree === false ? 'shared' : 'own');
    const terminal = this.nextId<TerminalId>('term-sub');
    const lead = this.members.get(caller);
    const sessionId = this.openSession(
      req.agent,
      worktree === 'own' ? `${this.root}/${r.crew.name}/${req.label}` : `${this.root}/${r.crew.name}`,
      lead?.sessionId ?? null,
      { crewId: r.crew.id, role: 'worker' },
      req.label,
      terminal,
    );
    const session: CrewSession = {
      sessionId,
      crewId: r.crew.id,
      label: req.label,
      agent: req.agent,
      workspaceId: null,
      worktree,
      branch: worktree === 'own' ? `${r.crew.branch}/${req.label}` : r.crew.branch,
      ...(req.owns ? { owns: [...req.owns] } : {}),
      firstPrompt: req.prompt,
      status: 'running',
      spawnedAt: nowIso(),
      closedAt: null,
      mergedAt: null,
      lastResult: null,
    };
    r.sessions.push(session);
    this.members.set(terminal, { crewId: r.crew.id, mode: r.crew.mode, role: 'worker', sessionId, taskId: null });
    this.terminalOf.set(sessionId, terminal);
    this.bus.emit({ type: 'crew.session-spawned', session: clone(session) });
    return clone(session);
  }

  async send(caller: TerminalId, target: CrewSessionRef, text: string): Promise<'sent' | 'busy' | 'waiting-for-user'> {
    const s = this.target(this.leadCrew(caller, 'send to sessions'), target);
    if (s.status === 'running') return 'busy';
    if (s.status === 'needs-you') return 'waiting-for-user';
    if (s.status === 'closed' || s.status === 'exited') fail('invalid-argument', `${s.label} is closed`);
    this.sent.push({ sessionId: s.sessionId, text });
    this.updateSession(s, { status: 'running' });
    return 'sent';
  }

  async read(caller: TerminalId, target: CrewSessionRef, lines = 20): Promise<string[]> {
    const s = this.target(this.leadCrew(caller, 'read sessions'), target);
    return (s.lastResult ?? '').split('\n').slice(-lines);
  }

  async result(caller: TerminalId, target: CrewSessionRef): Promise<{ text: string | null; source: 'transcript' | 'screen' }> {
    const s = this.target(this.leadCrew(caller, 'read sessions'), target);
    return { text: s.lastResult ?? null, source: 'transcript' };
  }

  async wait(caller: TerminalId, req: CrewWaitRequest): Promise<CrewWaitResult> {
    const r = this.leadCrew(caller, 'wait for sessions');
    const pool = req.mode === 'one' ? [this.target(r, req.target ?? '')] : r.sessions.filter((s) => s.status !== 'closed');
    const stopped = pool
      .filter((s) => STOPPED.includes(s.status))
      .map((s) => ({ label: s.label, sessionId: s.sessionId, status: s.status as CrewWaitResult['stopped'][number]['status'] }));
    const running = pool.filter((s) => s.status === 'running').map((s) => s.label);
    const timedOut = req.mode === 'all' ? running.length > 0 : stopped.length === 0;
    return { stopped, running, timedOut };
  }

  async diff(caller: TerminalId, target?: CrewSessionRef): Promise<string> {
    const r = this.crewOf(caller);
    const label = target === undefined ? 'self' : this.target(r, target).label;
    return `diff --git a/${label}.txt b/${label}.txt\n+changes from ${label}\n`;
  }

  async check(caller: TerminalId, target?: CrewSessionRef): Promise<CrewCheckResult> {
    const r = this.leadCrew(caller, 'run checks');
    const label = target === undefined ? r.crew.branch : this.target(r, target).label;
    return clone(this.checks.get(label) ?? { ok: true, exitCode: 0, output: `${r.crew.free?.check ?? r.crew.check ?? 'check'}: ok` });
  }

  async merge(caller: TerminalId, target: CrewSessionRef, opts: { continue?: boolean; abort?: boolean } = {}): Promise<CrewMergeResult> {
    const r = this.leadCrew(caller, 'merge');
    const s = this.target(r, target);
    if (opts.abort) {
      this.conflicts.delete(s.label);
      return { state: 'aborted' };
    }
    const files = this.conflicts.get(s.label);
    if (files && !opts.continue) return { state: 'conflict', files: [...files] };
    this.conflicts.delete(s.label);
    const locked = (r.crew.free?.lockedPaths ?? []).filter((p) => s.owns?.some((o) => o.startsWith(p.replace(/\*+$/, ''))));
    if (locked.length > 0 && !r.gates.some((g) => g.kind === 'locked-path' && g.resolved?.approved && g.detail === s.label)) {
      const gate = this.openGate(r, 'locked-path', null, `${s.label} touches a locked path`, s.label, 'gate', s.sessionId);
      return { state: 'gate', gateId: gate.id, paths: locked };
    }
    this.updateSession(s, { mergedAt: nowIso() });
    return { state: 'merged', commit: this.nextId<string>('commit') };
  }

  async close(caller: TerminalId, target: CrewSessionRef): Promise<void> {
    const s = this.target(this.leadCrew(caller, 'close sessions'), target);
    if (s.status === 'closed') return;
    this.updateSession(s, { status: 'closed', closedAt: nowIso() }, 'crew.session-closed');
    this.sessionsSvc?.stop(s.sessionId);
  }

  async ask(caller: TerminalId, question: string, options: string[] = []): Promise<InboxItemId> {
    const r = this.crewOf(caller);
    const m = this.members.get(caller);
    if (r.crew.mode === 'free' && m?.role === 'lead') {
      return this.openGate(r, 'lead-ask', null, question, null, 'lead-ask', m.sessionId, options).inboxItem as InboxItemId;
    }
    return this.addInbox(r, 'question', caller, m?.sessionId ?? null, 'Question', question, options).id;
  }

  async note(caller: TerminalId, text: string): Promise<void> {
    const r = this.crewOf(caller);
    const by = this.who(caller);
    const at = nowIso();
    r.notes.push({ by, text, at });
    this.bus.emit({ type: 'crew.note-added', crewId: r.crew.id, by, text, at });
  }

  async done(caller: TerminalId, summary: string): Promise<void> {
    const r = this.crewOf(caller);
    const m = this.members.get(caller);
    if (m?.role === 'lead') {
      if (r.crew.mode === 'template' && r.tasks.some((t) => t.status !== 'merged')) {
        fail('invalid-argument', 'Not every task is merged yet. Check agentdeck crew status.');
      }
      this.addInbox(r, 'ready-to-merge', null, m.sessionId, 'Ready to merge', summary, []);
      this.openGate(r, 'merge-into-main', null, `Merge ${r.crew.branch} into ${r.crew.baseBranch}`, summary, null, null);
      this.setState(r.crew.id, 'ready-to-merge');
      return;
    }
    // 模板模式的 Worker 交付：调度器接着跑检查（这里直接算过）、换家审
    const task = r.tasks.find((t) => t.id === m?.taskId);
    if (!task) fail('invalid-argument', 'You have no task to deliver');
    this.setTask(task, 'review');
  }

  // ---- 假实现专用 ----

  /** 命令行入口：按 cliCommandAllowed 放行，把 crew / session 命令转给上面的方法，回 CliResponse。 */
  async cli(caller: TerminalId, req: CliRequest): Promise<CliResponse> {
    try {
      const m = this.members.get(caller) ?? null;
      const parsed = parseCliCommand(req.command);
      if (parsed === null) fail('invalid-argument', `Unknown command: ${req.command}. Run agentdeck help.`);
      if (!cliCommandAllowed(req.command, { crew: m ? { mode: m.mode, role: m.role } : null, origin: m ? 'crew' : null })) {
        if (!m) fail('invalid-argument', 'Not in a crew.');
        const crew = this.require(m.crewId).crew;
        fail('invalid-argument', `Refused: only the lead of crew “${crew.name}” can run ${req.command}.`);
      }
      const flag = (name: string): string | undefined => {
        const i = req.args.indexOf(`--${name}`);
        return i >= 0 ? req.args[i + 1] : undefined;
      };
      const first = req.args.find((a) => !a.startsWith('--'));
      const key = `${parsed.group} ${parsed.verb ?? ''}`.trim();
      const data: unknown = await (async () => {
        switch (key) {
          case 'crew status':
            return this.status(caller, flag('since') ? { since: flag('since') as string } : {});
          case 'crew diff':
            return this.diff(caller, first);
          case 'crew check':
            return this.check(caller, first);
          case 'crew merge':
            return this.merge(caller, first ?? '', { continue: req.args.includes('--continue'), abort: req.args.includes('--abort') });
          case 'crew ask':
            return { item: await this.ask(caller, first ?? req.stdin ?? '') };
          case 'crew note':
            return this.note(caller, first ?? req.stdin ?? '').then(() => ({ noted: true }));
          case 'crew done':
            return this.done(caller, first ?? req.stdin ?? '').then(() => ({ done: true }));
          case 'session spawn':
            return this.spawn(caller, {
              agent: (flag('agent') ?? 'claude') as AgentKind,
              label: flag('label') ?? '',
              prompt: req.stdin ?? flag('prompt') ?? '',
              ...(req.args.includes('--shared') ? { worktree: 'shared' as const } : {}),
            });
          case 'session list':
            return this.status(caller).then((s) => s.sessions);
          case 'session read':
            return this.read(caller, first ?? '');
          case 'session result':
            return this.result(caller, first ?? '');
          case 'session send':
            return { result: await this.send(caller, first ?? '', req.stdin ?? '') };
          case 'session wait':
            return this.wait(caller, req.args.includes('--all') ? { mode: 'all' } : first ? { mode: 'one', target: first } : { mode: 'any' });
          case 'session close':
            return this.close(caller, first ?? '').then(() => ({ closed: first }));
          default:
            fail('unsupported', `${req.command} isn’t available in the fake crew service`);
        }
      })();
      return data === undefined ? { ok: true } : { ok: true, data };
    } catch (err) {
      if (err instanceof AgentDeckError || isAgentDeckErrorData(err)) return { ok: false, error: { code: err.code, message: err.message } };
      throw err;
    }
  }

  /** 子 session 停下来了（做完、等你、出错……），可以顺便给它的最后一条回复。 */
  setSessionStatus(crewId: CrewId, target: CrewSessionRef, status: CrewSessionStatus, lastResult?: string): void {
    const s = this.target(this.require(crewId), target);
    this.updateSession(s, { status, ...(lastResult !== undefined ? { lastResult } : {}) });
  }

  /** Lead 写任务表（crew add）。 */
  addTask(crewId: CrewId, init: Pick<CrewTask, 'id' | 'title'> & Partial<Pick<CrewTask, 'needs' | 'owns' | 'doneWhen' | 'wave'>>): CrewTask {
    const r = this.require(crewId);
    const task: CrewTask = {
      id: init.id,
      crewId,
      title: init.title,
      needs: init.needs ?? [],
      owns: init.owns ?? [],
      doneWhen: init.doneWhen ?? '',
      wave: init.wave ?? 1,
      status: 'waiting',
      round: 1,
      worktree: null,
      sessions: [],
    };
    r.tasks.push(task);
    this.bus.emit({ type: 'crew.task-changed', task: clone(task) });
    return clone(task);
  }

  /** 调度器改任务状态。working 时开 worktree 和 Worker 终端（Worker 能用 crew done）。返回 Worker 的终端。 */
  setTaskStatus(crewId: CrewId, taskId: CrewTaskId, status: CrewTaskStatus): TerminalId | null {
    const r = this.require(crewId);
    const task = r.tasks.find((t) => t.id === taskId);
    if (!task) fail('not-found', `No task ${taskId}`);
    let terminal: TerminalId | null = null;
    if (status === 'working' && task.sessions.length === 0) {
      const agent = r.crew.roles.find((x) => x.role === 'worker')?.agents[0] ?? 'codex';
      task.worktree = `${this.root}/${r.crew.name}/${task.id}`;
      terminal = this.nextId<TerminalId>('term-worker');
      const sessionId = this.openSession(agent, task.worktree, r.crew.leadSession, { crewId, role: 'worker', taskId }, `Worker · ${task.id}`, terminal);
      task.sessions.push({ sessionId, role: 'worker' });
      this.members.set(terminal, { crewId, mode: r.crew.mode, role: 'worker', sessionId, taskId });
      this.terminalOf.set(sessionId, terminal);
    }
    this.setTask(task, status);
    return terminal;
  }

  /** 预置 check 的结果（按子 session 标签，或集群分支名）。 */
  setCheck(target: string, result: CrewCheckResult): void {
    this.checks.set(target, result);
  }

  /** 预置下一次 merge 的冲突文件（按子 session 标签）。 */
  setConflict(label: string, files: string[]): void {
    this.conflicts.set(label, files);
  }

  /** Lead 的终端（模拟命令行的 caller）。 */
  leadTerminal(crewId: CrewId): TerminalId {
    return this.require(crewId).leadTerminal;
  }

  /**
   * 回放模板模式：建集群 → Lead 写 3 个任务 → Approve plan → 每个任务 working → Worker crew done → review → merge → merged
   * → Lead crew done → Ready to merge → 你点 Merge into main → merged。
   */
  async playTemplateRun(projectId: ProjectId = 'project-1' as ProjectId): Promise<CrewId> {
    const crew = await this.create({
      projectId,
      name: 'history-sidebar',
      mode: 'template',
      template: 'contract-first-build',
      goal: 'Add a history sidebar',
      baseBranch: 'main',
      roles: [
        { role: 'lead', agents: ['claude'], count: 1 },
        { role: 'worker', agents: ['codex', 'claude'], count: 3 },
        { role: 'reviewer', agents: ['claude'], count: 1 },
      ],
      check: 'pnpm check',
      limits: { maxAtOnce: 3, stopAfter: 480, waitForLimits: true, keepAwake: true },
      askMe: ['approve-plan', 'interface-change'],
    });
    const T = (id: string) => id as CrewTaskId;
    this.addTask(crew.id, { id: T('T1'), title: 'Contracts: HistoryService', owns: ['packages/contracts/**'] });
    this.addTask(crew.id, { id: T('T2'), title: 'Index claude sessions', needs: [T('T1')], owns: ['packages/agent-adapters/src/history/**'], wave: 2 });
    this.addTask(crew.id, { id: T('T3'), title: 'Sidebar list UI', needs: [T('T1')], owns: ['packages/ui/panels/history/**'], wave: 2 });
    const r = this.require(crew.id);
    const plan = this.openGate(r, 'approve-plan', null, 'Lead wrote 3 tasks in 2 waves. Nothing starts until you approve.', null, null, null);
    await this.resolveGate(plan.id, { approved: true });
    for (const t of ['T1', 'T2', 'T3']) {
      const worker = this.setTaskStatus(crew.id, T(t), 'working');
      if (worker) await this.done(worker, `${t} done`);
      this.setTaskStatus(crew.id, T(t), 'merge');
      this.setTaskStatus(crew.id, T(t), 'merged');
    }
    await this.done(r.leadTerminal, 'All 3 tasks merged');
    const gate = r.gates.find((g) => g.kind === 'merge-into-main' && g.resolved === null);
    if (gate) await this.resolveGate(gate.id, { approved: true });
    return crew.id;
  }

  /** 回放自由模式：建集群 → Lead 开 race（own）、docs（shared）→ wait → result → merge race → close → crew done → Ready to merge。 */
  async playFreeRun(projectId: ProjectId = 'project-1' as ProjectId): Promise<CrewId> {
    const crew = await this.create({
      projectId,
      name: 'login-fix',
      mode: 'free',
      goal: 'Login sometimes fails right after a token refresh. Find out why and fix it.',
      baseBranch: 'main',
      roles: [{ role: 'lead', agents: ['claude'], count: 1 }],
      limits: { maxAtOnce: 3, stopAfter: 240, waitForLimits: true, keepAwake: true },
      askMe: [],
      free: { allowedAgents: ['claude', 'codex', 'omp'], maxAtOnce: 3, check: 'pnpm check', stopAfter: 240, keepAwake: true, autoApprove: true },
    });
    const lead = this.leadTerminal(crew.id);
    await this.spawn(lead, { agent: 'codex', label: 'race', prompt: 'Check whether the refresh races with the retry.' });
    await this.spawn(lead, { agent: 'claude', label: 'docs', prompt: 'Read the auth docs, change nothing.', worktree: 'shared' });
    this.setSessionStatus(crew.id, 'docs', 'idle', 'The docs say tokens are saved before reuse.');
    await this.wait(lead, { mode: 'any' });
    await this.result(lead, 'docs');
    await this.close(lead, 'docs');
    this.setSessionStatus(crew.id, 'race', 'idle', 'Fixed: one refresh at a time. 10 of 10 pass.');
    await this.check(lead, 'race');
    await this.merge(lead, 'race');
    await this.close(lead, 'race');
    await this.done(lead, 'Login race fixed on crew/login-fix');
    return crew.id;
  }

  // ---- 内部 ----

  private openSession(
    agent: AgentKind,
    cwd: string,
    parentId: SessionId | null,
    origin: { crewId: CrewId; role: 'lead' | 'worker'; taskId?: CrewTaskId },
    label: string,
    terminalId: TerminalId,
  ): SessionId {
    const crewOrigin = { kind: 'crew' as const, crewId: origin.crewId, taskId: origin.taskId ?? null, role: origin.role };
    if (this.sessionsSvc) return this.sessionsSvc.open({ agent, cwd, parentId, origin: crewOrigin, label, terminalId }).id;
    return this.nextId<SessionId>('crew-session');
  }

  private require(id: CrewId): CrewRecord {
    const r = this.crews.get(id);
    if (!r) fail('not-found', 'Crew not found');
    return r;
  }

  private crewOf(caller: TerminalId): CrewRecord {
    const m = this.members.get(caller);
    if (!m) fail('invalid-argument', 'Not in a crew.');
    return this.require(m.crewId);
  }

  private leadCrew(caller: TerminalId, what: string): CrewRecord {
    const r = this.crewOf(caller);
    if (this.members.get(caller)?.role !== 'lead') fail('invalid-argument', `Refused: only the lead of crew “${r.crew.name}” can ${what}.`);
    return r;
  }

  private target(r: CrewRecord, ref: CrewSessionRef): CrewSession {
    const s = r.sessions.find((x) => x.label === ref || x.sessionId === ref);
    if (!s) fail('not-found', `No session “${ref}” in crew “${r.crew.name}”`);
    return s;
  }

  private openSubs(r: CrewRecord): CrewSession[] {
    return r.sessions.filter((s) => s.status !== 'closed' && s.status !== 'exited');
  }

  private maxAtOnce(r: CrewRecord): number {
    return r.crew.free?.maxAtOnce ?? r.crew.limits.maxAtOnce;
  }

  private who(caller: TerminalId): string {
    const m = this.members.get(caller);
    if (!m) return 'unknown';
    if (m.role === 'lead') return 'Lead';
    if (m.taskId) return m.taskId;
    const r = this.crews.get(m.crewId);
    return r?.sessions.find((s) => s.sessionId === m.sessionId)?.label ?? m.role;
  }

  private setState(id: CrewId, state: Crew['state']): Crew {
    this.require(id).crew.state = state;
    return this.crewChanged(id);
  }

  private crewChanged(id: CrewId): Crew {
    const r = this.require(id);
    r.crew.updatedAt = nowIso();
    this.bus.emit({ type: 'crew.changed', crew: clone(r.crew) });
    return clone(r.crew);
  }

  private setTask(task: CrewTask, status: CrewTaskStatus): void {
    task.status = status;
    this.bus.emit({ type: 'crew.task-changed', task: clone(task) });
  }

  private updateSession(
    s: CrewSession,
    patch: Partial<CrewSession>,
    type: 'crew.session-changed' | 'crew.session-closed' = 'crew.session-changed',
  ): void {
    Object.assign(s, patch);
    this.bus.emit({ type, session: clone(s) });
  }

  private openGate(
    r: CrewRecord,
    kind: CrewGateKind,
    taskId: CrewTaskId | null,
    summary: string,
    detail: string | null,
    source: InboxSource | null,
    sessionId: SessionId | null,
    options: string[] = [],
  ): CrewGate {
    const item = this.addInbox(r, source ?? 'gate', null, sessionId, gateTitle(kind), summary, options, kind);
    const gate: CrewGate = { id: this.nextId<string>('gate'), crewId: r.crew.id, kind, taskId, summary, detail, inboxItem: item.id, openedAt: nowIso(), resolved: null };
    item.gateId = gate.id;
    r.gates.push(gate);
    this.bus.emit({ type: 'crew.gate-changed', gate: clone(gate) });
    return gate;
  }

  private addInbox(
    r: CrewRecord,
    source: InboxSource,
    terminalId: TerminalId | null,
    sessionId: SessionId | null,
    title: string,
    summary: string,
    options: string[],
    gateKind: CrewGateKind | null = null,
  ): InboxItem {
    const item: InboxItem = {
      id: this.nextId<InboxItemId>('inbox'),
      source,
      crewId: r.crew.id,
      gateKind,
      terminalId,
      sessionId,
      title,
      from: terminalId ? this.who(terminalId) : 'Lead',
      summary,
      options,
      at: nowIso(),
      suggestion: null,
      resolved: null,
    };
    this.inbox.push(item);
    return item;
  }

  private resolveInbox(id: InboxItemId | null, answer: string): void {
    const item = this.inbox.find((i) => i.id === id);
    if (item) item.resolved = { by: 'user', answer, at: nowIso() };
  }

  private addDecision(r: CrewRecord, item: { id: string; title: string }, askedBy: string, question: string, answer: string, by: CrewDecision['by']): void {
    const decision: CrewDecision = { id: this.nextId<string>('decision'), crewId: r.crew.id, item, askedBy, question, answer, by, suggestedBy: null, at: nowIso() };
    r.decisions.push(decision);
    this.bus.emit({ type: 'crew.decision-added', decision: clone(decision) });
  }
}

function gateTitle(kind: CrewGateKind): string {
  switch (kind) {
    case 'approve-plan':
      return 'Approve plan';
    case 'interface-change':
      return 'Interface change';
    case 'before-merge':
      return 'Merge into crew branch';
    case 'stuck':
      return 'Stuck';
    case 'merge-into-main':
      return 'Merge into main';
    case 'lead-ask':
      return 'Question from the lead';
    case 'locked-path':
      return 'Locked path';
  }
}
