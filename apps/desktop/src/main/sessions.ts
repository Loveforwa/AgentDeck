// 主进程的 SessionService（M9 · SE2）。需求见设计画布“Session”页 S0，数据在 packages/store 的 sessions 表（SE1）。
//
//   agents.start ──start(req, launch)──→ 建一条或接回一条 Session，记下 terminalId（store 的 sessions.terminal_id）
//   钩子（runtime 的 tapHook）──noteHook──→ session-start 换了 agent 会话 id 时加一段（/clear、compact 算同一条的新一段）
//   tmux 事件 ──noteTerminalEvent──→ 进程退出：stopped，terminalId 清掉（关窗口 = 停进程，Session 留下）
//   重开应用 ──reconcile(tmux 列表)──→ 对不上活着的进程的改 stopped
//
// 服务不知道窗口：窗口和 Session 的对应只在白板上（TerminalWindowData.session，界面拿 StartAgentResult.session 存）。
// 每次变化发 session.changed（带完整的新值）。

import { randomUUID } from 'node:crypto';
import { AgentDeckError } from '@agentdeck/contracts';
import type {
  AgentHookEvent,
  AgentSessionId,
  AgentSessionReason,
  HandoffRequest,
  HandoffResult,
  IsoTime,
  LaunchMode,
  Session,
  SessionEvent,
  SessionId,
  SessionListOptions,
  SessionOrigin,
  SessionService,
  StartAgentRequest,
  StartAgentResult,
  TerminalEvent,
  TerminalId,
} from '@agentdeck/contracts';
import type { SessionRepository } from '@agentdeck/store';

/** 终端开出来之前（start 还没返回）就到的钩子、退出事件留多久。SessionStart 可能比 TerminalHost.create 返回还早。 */
export const EARLY_EVENT_MS = 10_000;

export interface SessionServiceDeps {
  repo: SessionRepository;
  emit: (event: SessionEvent) => void;
  /** 开一个 agent 终端（组装里的 agents.start：它再调 start(req, launch)）。handoff 用。 */
  startAgent: (req: StartAgentRequest) => Promise<StartAgentResult>;
  now?: () => IsoTime;
  newId?: () => SessionId;
  /** 毫秒，判断早到的事件过没过期。 */
  clock?: () => number;
}

/** runtime 的 tapHook 交过来的（ReceivedHook 的一部分）。 */
export interface SessionHook {
  terminalId: TerminalId;
  event: AgentHookEvent | null;
}

type Early = { kind: 'hook'; hook: SessionHook } | { kind: 'event'; event: TerminalEvent };

/** 这次启动算哪种开头：claude 启动时就知道会话 id，codex、omp 要等 SessionStart（可能不带 source）。 */
function launchReason(mode: LaunchMode): AgentSessionReason {
  return mode.kind === 'new' ? 'start' : mode.kind;
}

function notFound(id: SessionId): never {
  throw new AgentDeckError({ code: 'not-found', message: 'Session not found', detail: `session ${id}` });
}

export class SessionServiceImpl implements SessionService {
  private readonly repo: SessionRepository;
  private readonly now: () => IsoTime;
  private readonly newId: () => SessionId;
  private readonly clock: () => number;
  /** 还没对上 Session 的终端的事件（按到达先后）。 */
  private readonly early = new Map<TerminalId, { at: number; items: Early[] }>();
  /** 这次启动还没拿到会话 id 的终端：第一个 session-start 不带原因时按启动方式记。 */
  private readonly firstReason = new Map<TerminalId, AgentSessionReason>();

  constructor(private readonly deps: SessionServiceDeps) {
    this.repo = deps.repo;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID() as SessionId);
    this.clock = deps.clock ?? Date.now;
  }

  // ---- SessionService ----

  async list(opts: SessionListOptions = {}): Promise<Session[]> {
    return this.repo.list(opts);
  }

  async get(id: SessionId): Promise<Session> {
    return this.repo.get(id) ?? notFound(id);
  }

  async children(id: SessionId): Promise<Session[]> {
    if (!this.repo.get(id)) notFound(id);
    return this.repo.listByParent(id);
  }

  async rename(id: SessionId, label: string | null): Promise<Session> {
    const s = this.repo.get(id) ?? notFound(id);
    const name = label === null || label.trim() === '' ? null : label.trim();
    return this.save({ ...s, label: name, updatedAt: this.now() });
  }

  /**
   * 开一条子 session（origin handoff，第一条消息是 note），原来那条标成 handed-off，窗口和进程都不动。
   * 目标 agent 没装时 agents.start 抛 command-not-found，原来那条不变。
   * SE6 再加对话框、让上一家写说明、集群的换家；这里只是服务这一层。
   */
  async handoff(req: HandoffRequest): Promise<HandoffResult> {
    const from = this.repo.get(req.from) ?? notFound(req.from);
    const res = await this.deps.startAgent({
      agent: req.agent,
      cwd: from.cwd,
      workspaceId: from.workspaceId,
      mode: { kind: 'new' },
      prompt: req.note,
      parent: from.id,
      origin: { kind: 'handoff' },
      ...(req.size ? { size: req.size } : {}),
    });
    const started = res.session ? this.repo.get(res.session) : this.repo.findByTerminal(res.terminalId);
    if (!started) throw new AgentDeckError({ code: 'internal', message: 'The new session was not recorded' });
    const next = this.save({ ...started, handoffNote: req.note, updatedAt: this.now() });
    const after = this.repo.updateState(from.id, { state: 'handed-off', handedOffTo: next.id, at: this.now() });
    if (after) this.changed(after);
    return { session: next, terminalId: res.terminalId, cmd: res.cmd, args: res.args };
  }

  /** 简单的交接说明（英文）。分支、改了的文件、最后的输出、会话记录的路径由 SE6 补。 */
  async handoffSummary(id: SessionId): Promise<string> {
    const s = this.repo.get(id) ?? notFound(id);
    const last = s.agentSessions.at(-1);
    return [
      `Goal: continue ${s.label ?? s.title ?? 'the work in this session'}.`,
      `Working directory: ${s.cwd}`,
      last ? `Previous conversation: ${s.agent} session ${last.id}` : `Previous agent: ${s.agent}`,
    ].join('\n');
  }

  // ---- 组装用 ----

  /**
   * 包住 AgentService.start。接回哪一条：
   *   1. req.session：Reopen、恢复；库里没有（换了数据库）时用这个 id 新建，窗口的引用照样有效；
   *   2. 没带 session、mode 是 resume：按 agent 会话 id 找到的那条（X6 恢复、历史栏 Resume；界面写 data.session 之前也能接对）；
   *   3. 都没有：新建（兜底）。parent 不在库里时当没有；origin 不填时 fork 记 fork、resume 记 adopted、其余 user。
   * agent 不一样的不接（一条 Session 只有一家 agent）。launch 抛错时什么也不记。
   */
  async start(req: StartAgentRequest, launch: (req: StartAgentRequest) => Promise<StartAgentResult>): Promise<StartAgentResult> {
    let target = req.session ? this.repo.get(req.session) : null;
    if (!req.session && req.mode.kind === 'resume') target = this.repo.findByAgentSession(req.agent, req.mode.sessionId);
    const reuseId = req.session && !target ? req.session : null;
    if (target && target.agent !== req.agent) target = null;

    const res = await launch(req);
    const at = this.now();
    let session: Session;
    if (target) {
      // 开回同一条：名字、父子、来历都不变，换上新的终端。原来的终端还在跑时它的退出不再影响这条（terminalId 已经换了）。
      session = this.repo.updateState(target.id, { state: 'running', terminalId: res.terminalId, at }) ?? notFound(target.id);
    } else {
      const parentId = this.parentFor(req);
      session = {
        id: reuseId && !this.repo.get(reuseId) ? reuseId : this.newId(),
        agent: req.agent,
        workspaceId: req.workspaceId,
        cwd: req.cwd,
        parentId,
        origin: req.origin ?? this.defaultOrigin(req.mode),
        label: null,
        title: null,
        agentSessions: [],
        terminalId: res.terminalId,
        state: 'running',
        handedOffTo: null,
        handoffNote: null,
        createdAt: at,
        updatedAt: at,
      };
      this.repo.put(session);
    }

    const reason = launchReason(req.mode);
    if (res.sessionId) session = this.addSegment(session, res.sessionId, reason, at) ?? session;
    else this.firstReason.set(res.terminalId, reason);
    this.changed(session);
    this.flushEarly(res.terminalId);
    return { ...res, session: session.id };
  }

  /** runtime 的 tapHook 里调（不吞掉钩子）。只看 session-start。 */
  noteHook(hook: SessionHook): void {
    if (hook.event?.type !== 'session-start') return;
    const s = this.repo.findByTerminal(hook.terminalId);
    if (!s) {
      this.keepEarly(hook.terminalId, { kind: 'hook', hook });
      return;
    }
    const first = this.firstReason.get(hook.terminalId);
    this.firstReason.delete(hook.terminalId);
    let reason = hook.event.reason ?? 'unknown';
    if (reason === 'unknown' && first) reason = first;
    const next = this.addSegment(s, hook.event.sessionId, reason, this.now());
    if (next) this.changed(next);
  }

  /** TerminalHost 的事件。进程退出：stopped（handed-off 的保持），terminalId 清掉；tmux 没了：所有在跑的都停。 */
  noteTerminalEvent(event: TerminalEvent): void {
    if (event.type === 'terminal.exit') {
      const s = this.repo.findByTerminal(event.id);
      this.firstReason.delete(event.id);
      if (!s) {
        this.keepEarly(event.id, { kind: 'event', event });
        return;
      }
      this.stop(s);
    } else if (event.type === 'terminal.host-lost') {
      for (const s of this.repo.list()) if (s.terminalId !== null) this.stop(s);
      this.firstReason.clear();
    }
  }

  /** 重开应用拿到 tmux 列表后调一次：记着 terminalId、但进程已经没了（或只剩 remain-on-exit 的窗格）的改 stopped。 */
  reconcile(live: readonly { id: TerminalId; alive: boolean }[]): void {
    const alive = new Set(live.filter((t) => t.alive).map((t) => t.id));
    for (const s of this.repo.list()) if (s.terminalId !== null && !alive.has(s.terminalId)) this.stop(s);
  }

  /** 这个终端现在跑的是哪条 Session。 */
  sessionOf(terminalId: TerminalId): SessionId | null {
    return this.repo.findByTerminal(terminalId)?.id ?? null;
  }

  // ---- 内部 ----

  /** 换了 agent 会话 id 才加一段；和最后一段一样（启动时报的、resume 同一个、compact 不换 id）不加。 */
  private addSegment(s: Session, id: AgentSessionId, reason: AgentSessionReason, at: IsoTime): Session | null {
    if (s.agentSessions.at(-1)?.id === id) return null;
    return this.repo.addSegment(s.id, { id, startedAt: at, reason }, at);
  }

  private stop(s: Session): void {
    const next = this.repo.updateState(s.id, {
      state: s.state === 'handed-off' ? 'handed-off' : 'stopped',
      terminalId: null,
      at: this.now(),
    });
    if (next) this.changed(next);
  }

  private parentFor(req: StartAgentRequest): SessionId | null {
    if (req.parent) return this.repo.get(req.parent) ? req.parent : null;
    if (req.parent === undefined && req.mode.kind === 'fork') {
      // Fork into…：父是被 fork 的那条；AgentDeck 没记过时没有父，只在 origin 里记 agent 会话 id
      return this.repo.findByAgentSession(req.agent, req.mode.sessionId)?.id ?? null;
    }
    return null;
  }

  private defaultOrigin(mode: LaunchMode): SessionOrigin {
    if (mode.kind === 'fork') return { kind: 'fork', agentSessionId: mode.sessionId };
    if (mode.kind === 'resume') return { kind: 'adopted' };
    return { kind: 'user' };
  }

  private save(s: Session): Session {
    this.repo.put(s);
    const saved = this.repo.get(s.id) ?? s;
    this.changed(saved);
    return saved;
  }

  private changed(session: Session): void {
    this.deps.emit({ type: 'session.changed', session });
  }

  private keepEarly(terminalId: TerminalId, item: Early): void {
    const now = this.clock();
    for (const [id, e] of this.early) if (now - e.at > EARLY_EVENT_MS) this.early.delete(id);
    const e = this.early.get(terminalId) ?? { at: now, items: [] };
    e.items.push(item);
    this.early.set(terminalId, e);
  }

  private flushEarly(terminalId: TerminalId): void {
    const e = this.early.get(terminalId);
    this.early.delete(terminalId);
    if (!e || this.clock() - e.at > EARLY_EVENT_MS) return;
    for (const item of e.items) {
      if (item.kind === 'hook') this.noteHook(item.hook);
      else this.noteTerminalEvent(item.event);
    }
  }
}
