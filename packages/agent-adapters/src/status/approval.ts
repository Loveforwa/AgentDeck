// ApprovalService：Approve all（X3）和 Auto-approve（PL1）。跑在主进程，规则见 docs/plugins.md、DR-56。
//
// 两条路：
//   1. 钩子（claude、codex）：PermissionRequest 到 HookServer 时 decide() 回 allow，agent 只允许这一次、不留规则，
//      终端不进 needs-approval（runtime.ts 不把这条请求交给状态机），这里记一条 auto-approve 记录。
//   2. 按键：终端进了 needs-approval（Auto-approve 打开前就在等的；钩子回答没送到的；omp 本来就是这样），
//      发 agent 的“允许一次”按键（claude 1、codex y、omp Up Enter），2 秒内状态没离开 needs-approval 算 couldnt-approve。
//      omp 发键前要先在屏幕上认出确认框（screens.ts）。Approve all 也走这条。
// pi 从不请求批准，没事可做；kimi 先不支持（support.ts）。
//
// 不替你答的：提问（AskUserQuestion、ExitPlanMode、codex request_user_input、MCP elicitation 在适配器里就转成了 question，
// kind 不是 approval）；破坏性命令（Settings 的 destructivePatterns）。开着 Auto-approve 的终端停下来等你时，
// approval.needs-you 告诉界面原因（destructive / question / couldnt-approve / unsupported），界面显示 “Needs you”。
//
// 记录：每次批准（你点的、Approve all、Auto-approve）一条 ApprovalRecord。内存里留最近 MEMORY_RECORDS 条；
// 组装时传 records（packages/store 的 approval_history 表）就同时写进库，history() 从库里读。

import type {
  AgentKind,
  ApprovalRecord,
  ApprovalService,
  ApproveOptions,
  ApproveResult,
  AutoApproveNeedsYou,
  AutoApproveNeedsYouReason,
  AutoApproveState,
  AutoApproveSupport,
  PendingRequest,
  RequestId,
  StatusEvent,
  TerminalHost,
  TerminalId,
  TerminalStatus,
  WorkspaceId,
} from '@agentdeck/contracts';
import { AgentDeckError, WAITING_STATUSES } from '@agentdeck/contracts';
import type { ReceivedHook } from '../hook-server.ts';
import { AutoApproveScopes } from './auto-approve.ts';
import { compilePatterns, isDestructive } from './destructive.ts';
import type { TrackedTerminal } from './machine.ts';
import { matchApprovalScreen } from './screens.ts';
import type { ScreenKind, ScreenPrompt } from './screens.ts';
import { approvalStrategy, SUPPORT_AGENTS } from './support.ts';
import type { ApprovalStrategy } from './support.ts';

/** 状态机里 ApprovalService 用到的部分。 */
export interface ApprovalStatusSource {
  get(terminalId: TerminalId): { status: TerminalStatus; pending: PendingRequest | null; agent: AgentKind; workspaceId: WorkspaceId | null } | null;
  pendingRequests(): PendingRequest[];
  tracked(): TrackedTerminal[];
}

/** 批准记录存哪里（packages/store 的 ApprovalRepository 正好是这个形状）。 */
export interface ApprovalRecordStore {
  add(record: ApprovalRecord): void;
  history(workspaceId: WorkspaceId, limit: number): ApprovalRecord[] | Promise<ApprovalRecord[]>;
}

export interface ApprovalTiming {
  /** 发键后等多久状态还没变就算 couldnt-approve。默认 2000（contracts 的约定）。 */
  confirmMs?: number;
  /** 看屏幕的间隔。默认 250。 */
  pollMs?: number;
  /** 自动发键前先等一下，让确认框画完。默认 400。 */
  keyDelayMs?: number;
}

export interface ApprovalServiceOptions {
  status: ApprovalStatusSource;
  terminals: Pick<TerminalHost, 'sendKeys' | 'lastLines'>;
  /** 每种 agent 的“允许一次”按键（AgentAdapter.approveOnceKeys）。null 表示没有。 */
  approveKeys: (agent: AgentKind) => readonly string[] | null;
  /** Settings › Approvals › destructivePatterns，每次判断时现取。 */
  destructivePatterns: () => readonly string[];
  /** approval.auto-approved、approval.auto-approve-changed、approval.needs-you。 */
  emit: (event: StatusEvent) => void;
  records?: ApprovalRecordStore;
  timing?: ApprovalTiming;
  now?: () => Date;
  /** 写库失败时（不影响批准本身）。 */
  onError?: (error: unknown) => void;
  /**
   * AH3：每种 agent 的做法，默认 support.ts 的 approvalStrategy。runtime 按能力报告改：版本超过合格测试核对的版本时，
   * 靠认屏、按键的（omp）改成 unsupported，note 是 “Untested on <版本>”，不再替你按（TC-48）。
   */
  strategy?: (agent: AgentKind) => ApprovalStrategy;
}

/** 看屏幕时取最后多少行。 */
const SCREEN_LINES = 60;
/** 不传 records 时内存里留多少条。 */
const MEMORY_RECORDS = 1000;

type LeaveResult = 'left' | 'ended' | 'timeout';

interface Waiter {
  terminalId: TerminalId;
  requestId: RequestId;
  done: (r: LeaveResult) => void;
}

export class ApprovalServiceImpl implements ApprovalService {
  private readonly scopes = new AutoApproveScopes();
  private readonly memory: ApprovalRecord[] = [];
  private readonly inflight = new Map<RequestId, Promise<ApproveResult>>();
  /** 自动批准已经试过的请求，不重复试（再打开开关时会重试）。 */
  private readonly attempted = new Set<RequestId>();
  private readonly waiters = new Set<Waiter>();
  /** 自动批准按了键却没生效的请求（needs-you 的 couldnt-approve）。 */
  private readonly failed = new Set<RequestId>();
  /** 开着 Auto-approve 却在等你的终端。 */
  private readonly needsYou = new Map<TerminalId, AutoApproveNeedsYou>();
  private nextId = 1;
  private patternsSource: readonly string[] | null = null;
  private patterns: RegExp[] = [];
  private readonly confirmMs: number;
  private readonly pollMs: number;
  private readonly keyDelayMs: number;
  private readonly now: () => Date;
  private readonly strategy: (agent: AgentKind) => ApprovalStrategy;

  constructor(private readonly opts: ApprovalServiceOptions) {
    this.strategy = opts.strategy ?? approvalStrategy;
    this.confirmMs = opts.timing?.confirmMs ?? 2000;
    this.pollMs = opts.timing?.pollMs ?? 250;
    this.keyDelayMs = opts.timing?.keyDelayMs ?? 400;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- ApprovalService ----

  async approve(ids: RequestId[], opts: ApproveOptions = {}): Promise<ApproveResult[]> {
    const by = opts.by ?? (ids.length > 1 ? 'approve-all' : 'user');
    const includeDestructive = opts.includeDestructive ?? by === 'user';
    const pending = new Map(this.opts.status.pendingRequests().map((p) => [p.id, p]));
    return Promise.all(
      ids.map(async (id): Promise<ApproveResult> => {
        const p = pending.get(id);
        if (!p || p.kind !== 'approval') return { id, ok: false, reason: 'gone' };
        if (p.destructive && !includeDestructive) return { id, ok: false, reason: 'destructive' };
        return this.approveRequest(p, by);
      }),
    );
  }

  async setAutoApprove(workspaceId: WorkspaceId, on: boolean): Promise<void> {
    const inside = this.opts.status.tracked().filter((t) => t.workspaceId === workspaceId);
    if (this.scopes.setWorkspace(workspaceId, on, inside.map((t) => t.terminalId), this.iso())) this.emitState();
    if (on) this.sweep(inside);
    for (const t of inside) this.updateNeedsYou(t.terminalId);
  }

  async setTerminalAutoApprove(terminalId: TerminalId, on: boolean | null): Promise<void> {
    const t = this.opts.status.tracked().find((x) => x.terminalId === terminalId);
    if (on === true && t && this.strategy(t.agent).method === 'unsupported') {
      throw new AgentDeckError({ code: 'unsupported', message: this.strategy(t.agent).note ?? `Auto-approve is not supported for ${t.agent}` });
    }
    this.applyTerminal(terminalId, on, t);
  }

  /**
   * 重开应用时按白板恢复一个终端的开关（apps/desktop 调，不在 IPC 上）。和 setTerminalAutoApprove 不同，
   * agent 现在不支持（例如升到没核对过的版本，IS-154）也照样记下：不按键，要批准时报 needs-you（unsupported），
   * 界面的书签变 Needs you，用户看得出为什么不管用，也能自己关掉。
   */
  restoreTerminalAutoApprove(terminalId: TerminalId, on: boolean | null): void {
    this.applyTerminal(terminalId, on, this.opts.status.tracked().find((x) => x.terminalId === terminalId));
  }

  private applyTerminal(terminalId: TerminalId, on: boolean | null, t: TrackedTerminal | undefined): void {
    if (this.scopes.setTerminal(terminalId, on, t?.workspaceId ?? null, this.iso())) this.emitState();
    if (t && this.scopes.isOn(terminalId, t.workspaceId)) this.sweep([t]);
    this.updateNeedsYou(terminalId);
  }

  async autoApproveNeedsYou(): Promise<AutoApproveNeedsYou[]> {
    return [...this.needsYou.values()].map((n) => structuredClone(n));
  }

  async autoApproveState(): Promise<AutoApproveState> {
    return this.scopes.state();
  }

  async autoApproveSupport(): Promise<AutoApproveSupport[]> {
    return SUPPORT_AGENTS.map((a) => {
      const { screen: _screen, ...rest } = this.strategy(a);
      return rest;
    });
  }

  async history(workspaceId: WorkspaceId, limit: number): Promise<ApprovalRecord[]> {
    if (this.opts.records) return this.opts.records.history(workspaceId, limit);
    return this.memory
      .filter((r) => r.request.workspaceId === workspaceId)
      .reverse()
      .slice(0, Math.max(0, limit))
      .map((r) => structuredClone(r));
  }

  // ---- 给 runtime 接线用 ----

  /** 这个终端现在开没开 Auto-approve。 */
  isOn(terminalId: TerminalId): boolean {
    return this.scopes.isOn(terminalId, this.opts.status.get(terminalId)?.workspaceId ?? null);
  }

  /**
   * HookServer 的 decide：PermissionRequest 要不要直接回 allow。
   * 只对批准类请求（提问在适配器里已经是 question）、用钩子批准的 agent、开着 Auto-approve、不是破坏性命令时回 allow。
   * 没 track 的终端（钩子比 track 早到）不知道在哪个框，回 none；track 之后进 needs-approval 再走按键。
   */
  decide(hook: ReceivedHook): 'allow' | 'none' {
    const e = hook.event;
    if (e?.type !== 'permission-request') return 'none';
    if (this.strategy(hook.agent).method !== 'hook') return 'none';
    const t = this.opts.status.get(hook.terminalId);
    if (!t || !this.scopes.isOn(hook.terminalId, t.workspaceId)) return 'none';
    if (isDestructive(this.compiledPatterns(), e.command, e.summary)) return 'none';
    return 'allow';
  }

  /** decide 回了 allow、而且送到了 agent：记一条 auto-approve。 */
  noteAutoAllowed(hook: ReceivedHook): void {
    const e = hook.event;
    if (e?.type !== 'permission-request') return;
    const t = this.opts.status.get(hook.terminalId);
    this.record(
      {
        id: this.newId('auto'),
        terminalId: hook.terminalId,
        workspaceId: t?.workspaceId ?? null,
        agent: hook.agent,
        kind: 'approval',
        summary: e.summary,
        command: e.command,
        destructive: false,
        at: this.iso(),
      },
      'auto-approve',
    );
  }

  /** 状态机发出的事件（runtime 包一层 emit 接过来）。 */
  onStatusEvent(event: StatusEvent): void {
    if (event.type !== 'status.changed') return;
    const s = event.snapshot;
    for (const w of [...this.waiters]) {
      if (w.terminalId !== s.terminalId || s.pending?.id === w.requestId) continue;
      w.done(s.status === 'exited' || s.status === 'error' ? 'ended' : 'left');
    }
    if (s.status === 'needs-approval' && s.pending?.kind === 'approval') this.maybeAuto(s.pending, false);
    this.updateNeedsYou(s.terminalId);
  }

  // ---- 内部 ----

  private sweep(terminals: readonly TrackedTerminal[]): void {
    for (const t of terminals) {
      if (!this.scopes.isOn(t.terminalId, t.workspaceId)) continue;
      if (t.pending?.kind === 'approval') this.maybeAuto(t.pending, true);
    }
  }

  /** 开着 Auto-approve 的终端现在为什么在等你；原因变了才发 approval.needs-you。 */
  private updateNeedsYou(terminalId: TerminalId): void {
    const t = this.opts.status.get(terminalId);
    let reason: AutoApproveNeedsYouReason | null = null;
    const p = t?.pending ?? null;
    if (t && p && WAITING_STATUSES.includes(t.status) && this.scopes.isOn(terminalId, t.workspaceId)) {
      const method = this.strategy(p.agent).method;
      if (p.kind === 'question') reason = 'question';
      else if (p.destructive) reason = 'destructive';
      else if ((method !== 'hook' && method !== 'keys') || !this.opts.approveKeys(p.agent)?.length) reason = 'unsupported';
      else if (this.failed.has(p.id)) reason = 'couldnt-approve';
      // 其他情况：马上替你按，不算等你
    }
    const prev = this.needsYou.get(terminalId);
    if (reason && p) {
      if (prev?.reason === reason && prev.request.id === p.id) return;
      const next: AutoApproveNeedsYou = { terminalId, reason, request: structuredClone(p) };
      this.needsYou.set(terminalId, next);
      this.opts.emit({ type: 'approval.needs-you', terminalId, reason, request: structuredClone(p) });
    } else if (prev) {
      this.needsYou.delete(terminalId);
      this.opts.emit({ type: 'approval.needs-you', terminalId, reason: null, request: null });
    }
  }

  /** 一条在等的批准请求，开着 Auto-approve 时按键批准。retry：打开开关时，之前没按成的也再试一次。 */
  private maybeAuto(pending: PendingRequest, retry: boolean): void {
    if (pending.destructive) return;
    const method = this.strategy(pending.agent).method;
    if (method !== 'hook' && method !== 'keys') return;
    if (!this.scopes.isOn(pending.terminalId, pending.workspaceId)) return;
    if (this.attempted.has(pending.id) && !retry) return;
    this.attempted.add(pending.id);
    if (retry && this.failed.delete(pending.id)) this.updateNeedsYou(pending.terminalId);
    setTimeout(() => {
      if (!this.stillWaiting(pending) || !this.isOn(pending.terminalId)) return;
      void this.approveRequest(pending, 'auto-approve').then((r) => {
        if (!r.ok && r.reason === 'couldnt-approve') {
          this.failed.add(pending.id);
          this.updateNeedsYou(pending.terminalId);
        }
      });
    }, this.keyDelayMs);
  }

  /** 同一条请求同时只按一次（Approve all 和 Auto-approve 撞上时共用结果）。 */
  private approveRequest(pending: PendingRequest, by: ApprovalRecord['by']): Promise<ApproveResult> {
    const running = this.inflight.get(pending.id);
    if (running) return running;
    const p = this.sendApproveKeys(pending, by).finally(() => this.inflight.delete(pending.id));
    this.inflight.set(pending.id, p);
    return p;
  }

  private async sendApproveKeys(pending: PendingRequest, by: ApprovalRecord['by']): Promise<ApproveResult> {
    const id = pending.id;
    const strategy = this.strategy(pending.agent);
    const keys = this.opts.approveKeys(pending.agent);
    if ((strategy.method !== 'hook' && strategy.method !== 'keys') || !keys || keys.length === 0) {
      return { id, ok: false, reason: 'unsupported' };
    }
    if (!this.stillWaiting(pending)) return { id, ok: false, reason: 'gone' };
    if (strategy.screen) {
      // omp：扩展先报了请求，确认框可能还没画出来；认不出就不发键（按错了可能选成 Deny 或打进输入框）
      const prompt = await this.waitForScreen(pending.terminalId, strategy.screen);
      if (!this.stillWaiting(pending)) return { id, ok: false, reason: 'gone' };
      if (!prompt) return { id, ok: false, reason: 'couldnt-approve' };
    }
    const left = this.waitLeave(pending.terminalId, id);
    try {
      await this.opts.terminals.sendKeys(pending.terminalId, [...keys]);
    } catch {
      left.cancel();
      return { id, ok: false, reason: 'gone' };
    }
    const r = await left.result;
    if (r === 'timeout') return { id, ok: false, reason: 'couldnt-approve' };
    if (r === 'ended') return { id, ok: false, reason: 'gone' };
    this.record(pending, by);
    return { id, ok: true };
  }

  private async readScreen(terminalId: TerminalId, kind: ScreenKind): Promise<ScreenPrompt | null> {
    try {
      return matchApprovalScreen(kind, await this.opts.terminals.lastLines(terminalId, SCREEN_LINES));
    } catch {
      return null;
    }
  }

  /** 等确认框出现（最多 confirmMs）。 */
  private async waitForScreen(terminalId: TerminalId, kind: ScreenKind): Promise<ScreenPrompt | null> {
    const deadline = Date.now() + this.confirmMs;
    for (;;) {
      const prompt = await this.readScreen(terminalId, kind);
      if (prompt || Date.now() >= deadline) return prompt;
      await sleep(this.pollMs);
    }
  }

  /** 等终端离开这条请求的 needs-approval，最多 confirmMs。先注册再发键，免得状态变得比发键返回还快。 */
  private waitLeave(terminalId: TerminalId, requestId: RequestId): { result: Promise<LeaveResult>; cancel: () => void } {
    let finish: (r: LeaveResult) => void = () => undefined;
    const result = new Promise<LeaveResult>((resolve) => {
      const timer = setTimeout(() => finish('timeout'), this.confirmMs);
      const w: Waiter = { terminalId, requestId, done: (r) => finish(r) };
      finish = (r) => {
        clearTimeout(timer);
        this.waiters.delete(w);
        resolve(r);
      };
      this.waiters.add(w);
    });
    return { result, cancel: () => finish('timeout') };
  }

  private stillWaiting(pending: PendingRequest): boolean {
    const t = this.opts.status.get(pending.terminalId);
    return t?.status === 'needs-approval' && t.pending?.id === pending.id;
  }

  private record(request: PendingRequest, by: ApprovalRecord['by']): ApprovalRecord {
    const record: ApprovalRecord = { request: structuredClone(request), by, at: this.iso() };
    this.memory.push(record);
    if (this.memory.length > MEMORY_RECORDS) this.memory.splice(0, this.memory.length - MEMORY_RECORDS);
    try {
      this.opts.records?.add(record);
    } catch (e) {
      this.opts.onError?.(e);
    }
    if (by === 'auto-approve') this.opts.emit({ type: 'approval.auto-approved', record: structuredClone(record) });
    return record;
  }

  private emitState(): void {
    this.opts.emit({ type: 'approval.auto-approve-changed', state: this.scopes.state() });
  }

  private compiledPatterns(): RegExp[] {
    const src = this.opts.destructivePatterns();
    if (src !== this.patternsSource) {
      this.patternsSource = src;
      this.patterns = compilePatterns(src);
    }
    return this.patterns;
  }

  private newId(prefix: string): RequestId {
    return `${prefix}-${this.nextId++}` as RequestId;
  }

  private iso(): string {
    return this.now().toISOString();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
