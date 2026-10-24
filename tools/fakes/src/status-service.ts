// StatusService 和 ApprovalService 的假实现。
// 状态可以直接驱动（requestApproval、turnEnd……，scenario 用的就是这些），
// 也可以跟着假终端的 activity / silence / exit 自动变，规则比线 4 的真状态机简单得多。

import type {
  AgentKind,
  ApprovalRecord,
  ApprovalService,
  ApproveOptions,
  ApproveResult,
  AutoApproveNeedsYou,
  AutoApproveState,
  AutoApproveSupport,
  PendingRequest,
  RequestId,
  StatusService,
  StatusSnapshot,
  TerminalHost,
  TerminalId,
  TerminalStatus,
  WorkspaceId,
} from '@agentdeck/contracts';
import { isAutoApproveOn, WAITING_STATUSES } from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';
import { clone, idGenerator, nowIso, sleep } from './util.ts';

export interface TrackedTerminal {
  agent: AgentKind;
  workspaceId: WorkspaceId | null;
}

export interface FakeStatusServiceOptions {
  bus?: FakeEventBus;
  /** 判断破坏性命令用的正则（字符串），通常来自 Settings › Approvals。 */
  destructivePatterns?: () => readonly string[];
  /** 跟着 terminal.activity / silence / exit 自动改状态，默认 true。 */
  followTerminals?: boolean;
}

interface Entry extends TrackedTerminal {
  snap: StatusSnapshot;
}

export class FakeStatusService implements StatusService {
  readonly bus: FakeEventBus;
  private readonly entries = new Map<TerminalId, Entry>();
  private readonly destructivePatterns: () => readonly string[];
  private readonly nextId = idGenerator();
  /** FakeApprovalService 挂上来的 Auto-approve 判断。返回记录表示已自动批准。 */
  autoApprove: ((pending: PendingRequest) => ApprovalRecord | null) | null = null;

  constructor(opts: FakeStatusServiceOptions = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
    this.destructivePatterns = opts.destructivePatterns ?? (() => []);
    if (opts.followTerminals ?? true) {
      this.bus.on('terminal.activity', ({ id }) => {
        const s = this.entries.get(id)?.snap.status;
        if (s === 'starting' || s === 'idle') this.set(id, 'running');
      });
      this.bus.on('terminal.silence', ({ id }) => {
        if (this.entries.get(id)?.snap.status === 'running') this.set(id, 'idle');
      });
      this.bus.on('terminal.exit', ({ id, code }) => {
        if (this.entries.has(id)) this.exited(id, code);
      });
    }
  }

  async snapshot(): Promise<StatusSnapshot[]> {
    return [...this.entries.values()].map((e) => clone(e.snap));
  }

  // ---- 驱动状态 ----

  /** 开始跟踪一个终端（agents.start 会调）。 */
  track(terminalId: TerminalId, t: TrackedTerminal, status: TerminalStatus = 'starting'): void {
    this.entries.set(terminalId, {
      ...t,
      snap: { terminalId, status, since: nowIso(), exitCode: null, pending: null },
    });
    this.emit(terminalId);
  }

  untrack(terminalId: TerminalId): void {
    this.entries.delete(terminalId);
  }

  /** 直接设状态。离开等待状态时清掉 pending。 */
  set(terminalId: TerminalId, status: TerminalStatus, extra: { exitCode?: number | null; pending?: PendingRequest | null } = {}): void {
    const e = this.require(terminalId);
    const pending = extra.pending !== undefined ? extra.pending : WAITING_STATUSES.includes(status) ? e.snap.pending : null;
    e.snap = {
      terminalId,
      status,
      since: e.snap.status === status && e.snap.pending === pending ? e.snap.since : nowIso(),
      exitCode: extra.exitCode !== undefined ? extra.exitCode : e.snap.exitCode,
      pending,
    };
    this.emit(terminalId);
  }

  running(terminalId: TerminalId): void {
    this.set(terminalId, 'running');
  }

  /** 一轮结束：变空闲，发 agent.turn-end（源代码管理面板据此刷新）。 */
  turnEnd(terminalId: TerminalId): void {
    const e = this.require(terminalId);
    this.set(terminalId, 'idle');
    this.bus.emit({ type: 'agent.turn-end', terminalId, workspaceId: e.workspaceId });
  }

  exited(terminalId: TerminalId, code: number): void {
    this.set(terminalId, code === 0 ? 'exited' : 'error', { exitCode: code });
  }

  /**
   * agent 请求批准。工作区开了 Auto-approve 且不是破坏性命令时直接批准（返回 null，发 approval.auto-approved）；
   * 否则进入 needs-approval，返回这条请求。
   */
  requestApproval(
    terminalId: TerminalId,
    req: { summary: string; command?: string | null },
  ): PendingRequest | null {
    const pending = this.makePending(terminalId, 'approval', req.summary, req.command ?? null);
    const record = this.autoApprove?.(pending) ?? null;
    if (record) {
      this.set(terminalId, 'running');
      this.bus.emit({ type: 'approval.auto-approved', record: clone(record) });
      return null;
    }
    this.set(terminalId, 'needs-approval', { pending });
    return clone(pending);
  }

  /** agent 用提问工具问你。 */
  askQuestion(terminalId: TerminalId, summary: string): PendingRequest {
    const pending = this.makePending(terminalId, 'question', summary, null);
    this.set(terminalId, 'needs-reply', { pending });
    return clone(pending);
  }

  /** 所有在等你的请求。 */
  pending(): PendingRequest[] {
    return [...this.entries.values()].flatMap((e) => (e.snap.pending ? [clone(e.snap.pending)] : []));
  }

  info(terminalId: TerminalId): (TrackedTerminal & { snapshot: StatusSnapshot }) | null {
    const e = this.entries.get(terminalId);
    return e ? { agent: e.agent, workspaceId: e.workspaceId, snapshot: clone(e.snap) } : null;
  }

  findRequest(id: RequestId): PendingRequest | null {
    for (const e of this.entries.values()) if (e.snap.pending?.id === id) return e.snap.pending;
    return null;
  }

  isDestructive(command: string | null): boolean {
    if (!command) return false;
    return this.destructivePatterns().some((p) => {
      try {
        return new RegExp(p, 'i').test(command);
      } catch {
        return false;
      }
    });
  }

  // ---- 内部 ----

  private makePending(terminalId: TerminalId, kind: PendingRequest['kind'], summary: string, command: string | null): PendingRequest {
    const e = this.require(terminalId);
    return {
      id: this.nextId<RequestId>('req'),
      terminalId,
      workspaceId: e.workspaceId,
      agent: e.agent,
      kind,
      summary,
      command,
      destructive: this.isDestructive(command),
      at: nowIso(),
    };
  }

  private require(terminalId: TerminalId): Entry {
    const e = this.entries.get(terminalId);
    if (!e) throw new Error(`FakeStatusService: terminal ${terminalId} is not tracked; call track() first`);
    return e;
  }

  private emit(terminalId: TerminalId): void {
    const e = this.require(terminalId);
    this.bus.emit({ type: 'status.changed', snapshot: clone(e.snap) });
  }
}

export interface FakeApprovalServiceOptions {
  status: FakeStatusService;
  terminals: TerminalHost;
  /** 每种 agent 的“允许一次”按键；null 表示不支持（对应 AgentAdapter.approveOnceKeys）。 */
  approveKeys: (agent: AgentKind) => string[] | null;
  /** 模拟卡住时等多久才判 couldnt-approve，默认 2000（和接口注释一致）。 */
  stuckTimeoutMs?: number;
}

export class FakeApprovalService implements ApprovalService {
  private readonly status: FakeStatusService;
  private readonly terminals: TerminalHost;
  private readonly approveKeys: (agent: AgentKind) => string[] | null;
  private readonly stuckTimeoutMs: number;
  private readonly autoOn = new Map<WorkspaceId, string>();
  /** 单个终端的设置（PL1）。 */
  private readonly terminalAuto = new Map<TerminalId, { on: boolean; since: string }>();
  private readonly stuck = new Set<TerminalId>();
  /** 新的在后。 */
  private readonly records: ApprovalRecord[] = [];

  constructor(opts: FakeApprovalServiceOptions) {
    this.status = opts.status;
    this.terminals = opts.terminals;
    this.approveKeys = opts.approveKeys;
    this.stuckTimeoutMs = opts.stuckTimeoutMs ?? 2000;
    this.status.autoApprove = (pending) => {
      if (!isAutoApproveOn(this.state(), pending.terminalId, pending.workspaceId) || pending.destructive) return null;
      const keys = this.approveKeys(pending.agent);
      if (!keys) return null;
      void this.terminals.sendKeys(pending.terminalId, keys).catch(() => undefined);
      return this.record(pending, 'auto-approve');
    };
  }

  async approve(ids: RequestId[], opts: ApproveOptions = {}): Promise<ApproveResult[]> {
    const by = opts.by ?? (ids.length > 1 ? 'approve-all' : 'user');
    const includeDestructive = opts.includeDestructive ?? by === 'user';
    return Promise.all(
      ids.map(async (id): Promise<ApproveResult> => {
        const pending = this.status.findRequest(id);
        if (!pending || pending.kind !== 'approval') return { id, ok: false, reason: 'gone' };
        if (pending.destructive && !includeDestructive) return { id, ok: false, reason: 'destructive' };
        const keys = this.approveKeys(pending.agent);
        if (!keys) return { id, ok: false, reason: 'unsupported' };
        try {
          await this.terminals.sendKeys(pending.terminalId, keys);
        } catch {
          return { id, ok: false, reason: 'gone' };
        }
        if (this.stuck.has(pending.terminalId)) {
          await sleep(this.stuckTimeoutMs);
          return { id, ok: false, reason: 'couldnt-approve' };
        }
        this.status.running(pending.terminalId);
        this.record(pending, by);
        return { id, ok: true };
      }),
    );
  }

  async setAutoApprove(workspaceId: WorkspaceId, on: boolean): Promise<void> {
    if (on) this.autoOn.set(workspaceId, this.autoOn.get(workspaceId) ?? nowIso());
    else this.autoOn.delete(workspaceId);
    this.status.bus.emit({ type: 'approval.auto-approve-changed', state: this.state() });
  }

  /** 简化：不清框里其他终端的设置，也不补按已经在等的请求（真实现见 agent-adapters 的 ApprovalServiceImpl）。 */
  async setTerminalAutoApprove(terminalId: TerminalId, on: boolean | null): Promise<void> {
    if (on === null) this.terminalAuto.delete(terminalId);
    else this.terminalAuto.set(terminalId, { on, since: nowIso() });
    this.status.bus.emit({ type: 'approval.auto-approve-changed', state: this.state() });
  }

  async autoApproveState(): Promise<AutoApproveState> {
    return this.state();
  }

  async autoApproveSupport(): Promise<AutoApproveSupport[]> {
    return ['claude', 'codex', 'kimi', 'omp', 'pi', 'shell', 'custom'].map((agent) => {
      if (agent === 'pi') return { agent, method: 'never-asks', verified: true, note: 'pi never asks for approval' };
      if (agent === 'claude' || agent === 'codex') return { agent, method: 'hook', verified: true, note: null };
      if (agent === 'omp') return { agent, method: 'keys', verified: false, note: 'Untested for Oh My Pi' };
      return { agent, method: 'unsupported', verified: false, note: `Not supported for ${agent}${agent === 'kimi' ? ' yet' : ''}` };
    });
  }

  /** 简化：开着 Auto-approve 的终端里在等的破坏性命令和提问算 needs you（不发 approval.needs-you 事件）。 */
  async autoApproveNeedsYou(): Promise<AutoApproveNeedsYou[]> {
    return (await this.status.snapshot()).flatMap((s): AutoApproveNeedsYou[] => {
      const p = s.pending;
      if (!p || !isAutoApproveOn(this.state(), s.terminalId, p.workspaceId)) return [];
      if (p.kind === 'question') return [{ terminalId: s.terminalId, reason: 'question', request: clone(p) }];
      if (p.destructive) return [{ terminalId: s.terminalId, reason: 'destructive', request: clone(p) }];
      return [];
    });
  }

  async history(workspaceId: WorkspaceId, limit: number): Promise<ApprovalRecord[]> {
    return this.records
      .filter((r) => r.request.workspaceId === workspaceId)
      .reverse()
      .slice(0, Math.max(0, limit))
      .map((r) => clone(r));
  }

  // ---- 假实现专用 ----

  /** 模拟按键发出去了但 agent 没反应：approve 等 stuckTimeoutMs 后返回 couldnt-approve。 */
  simulateStuck(terminalId: TerminalId, stuck = true): void {
    if (stuck) this.stuck.add(terminalId);
    else this.stuck.delete(terminalId);
  }

  isAutoApprove(workspaceId: WorkspaceId): boolean {
    return this.autoOn.has(workspaceId);
  }

  private state(): AutoApproveState {
    return {
      workspaces: [...this.autoOn].map(([workspaceId, since]) => ({ workspaceId, since })),
      terminals: [...this.terminalAuto].map(([terminalId, t]) => ({ terminalId, on: t.on, since: t.since })),
    };
  }

  private record(request: PendingRequest, by: ApprovalRecord['by']): ApprovalRecord {
    const r: ApprovalRecord = { request: clone(request), by, at: nowIso() };
    this.records.push(r);
    return r;
  }
}
