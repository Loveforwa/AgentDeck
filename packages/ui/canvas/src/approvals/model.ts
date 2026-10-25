// 批准在界面这边的状态（PL1 Auto-approve 插件、Approval history、X3 Approve all）。
// 运行时的开关以主进程的 ApprovalService 为准：这里只读它（autoApproveState + approval.auto-approve-changed），
// 用户点开关时调服务，再按 approval.auto-approve-changed 把开关写进白板（FrameNode.autoApprove、TerminalWindowData.autoApprove）
// 随白板保存。重开应用时由 apps/desktop 在终端接回状态机后按白板恢复一次，界面不再推一遍（免得重复）；
// 只有终端换了 terminalId（重启、电脑重启后新开）时，界面把它单独的设置补推给服务。
// 不依赖 React；BoardController 建它（controller.approvals），React 组件订阅 store。

import { createStore, type StoreApi } from 'zustand/vanilla';
import { isAutoApproveOn, WAITING_STATUSES } from '@agentdeck/contracts';
import type {
  AgentKind,
  ApprovalRecord,
  AutoApproveNeedsYouReason,
  AutoApproveState,
  AutoApproveSupport,
  PendingRequest,
  TerminalId,
  TerminalWindowData,
  Unsubscribe,
  WindowId,
  WindowNode,
  WorkspaceId,
} from '@agentdeck/contracts';
import type { BoardController } from '../controller.ts';
import { agentOf, isAgentTerminal, isTerminal, terminalIdOf } from '../model/windows.ts';
import type { BoardStoreState } from '../store.ts';
import { pendingApprovals, pendingQuestions, plural } from './text.ts';

export interface NeedsYou {
  reason: AutoApproveNeedsYouReason;
  request: PendingRequest | null;
}

/** Approve all 里没批成的一行留下来，写原因。 */
export type ApproveAllOutcome = 'couldnt-approve' | 'unsupported' | 'destructive';

export interface ApproveAllRow {
  request: PendingRequest;
  checked: boolean;
  outcome: ApproveAllOutcome | null;
}

export interface ApproveAllState {
  rows: ApproveAllRow[];
  /** 在等你回答问题的个数（不在列表里，底下说一句）。 */
  questions: number;
  busy: boolean;
}

export interface HistoryState {
  workspaceId: WorkspaceId | null;
  /** 给了就只列这个终端的。 */
  terminalId: TerminalId | null;
  /** 新的在前；读的时候为 null。 */
  records: ApprovalRecord[] | null;
  error: string | null;
}

export type AutoApproveTarget = { kind: 'terminal'; windowId: WindowId } | { kind: 'frame'; workspaceId: WorkspaceId };

export type Availability = { ok: true } | { ok: false; reason: string };

export interface ApprovalsState {
  /** 服务报的开关（真相）。 */
  auto: AutoApproveState;
  /** 每种 agent 能不能开。没取到时为 null（菜单项照常可点，服务不支持会报错）。 */
  support: AutoApproveSupport[] | null;
  /** 开着 Auto-approve、现在要你自己处理的终端（按 terminalId）。 */
  needsYou: Record<string, NeedsYou>;
  /** 这次运行里收到的自动批准，按 terminalId，新的在前（散放的终端没有 history 可查，靠它）。 */
  recent: Record<string, ApprovalRecord[]>;
  /** 每次自动批准加一，书签闪一下。 */
  flash: Record<string, number>;
  /** 点开书签的小卡片。 */
  popover: WindowId | null;
  /** 小卡片里最近的几条批准；读的时候为 null。 */
  popoverRecords: ApprovalRecord[] | null;
  history: HistoryState | null;
  /** 第一次打开时问一句。 */
  confirm: AutoApproveTarget | null;
  approveAll: ApproveAllState | null;
}

/** 服务的 autoApproveSupport() 还没取到时，当作能自动批准的 agent（取到后以服务为准）。 */
export const AUTO_APPROVE_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'omp', 'pi'];

const EMPTY: AutoApproveState = { workspaces: [], terminals: [] };
const RECENT_MAX = 20;
const POPOVER_RECORDS = 4;
const HISTORY_LIMIT = 200;
/** 第一次开 Auto-approve 时问过一句，之后不再问（只存在这台机器的这个界面里）。 */
export const CONFIRMED_KEY = 'agentdeck.auto-approve.confirmed';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readConfirmed(): boolean {
  try {
    return globalThis.localStorage?.getItem(CONFIRMED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeConfirmed(): void {
  try {
    globalThis.localStorage?.setItem(CONFIRMED_KEY, '1');
  } catch {
    // 存不了就下次再问
  }
}

/** 同一条请求同一种批准只算一次（history 和这次运行收到的事件会重复）。新的在前。 */
export function mergeRecords(...lists: readonly (readonly ApprovalRecord[])[]): ApprovalRecord[] {
  const seen = new Set<string>();
  const out: ApprovalRecord[] = [];
  for (const r of lists.flat()) {
    const key = `${r.request.id}|${r.by}|${r.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export class ApprovalsModel {
  readonly store: StoreApi<ApprovalsState>;
  private readonly unsubs: Unsubscribe[] = [];
  /** 每个终端窗口上次看到的 terminalId，换了 id 时补推单独的设置。 */
  private readonly seenTerminalIds = new Map<WindowId, TerminalId | null>();
  private autoSeq = 0;

  constructor(
    private readonly c: BoardController,
    private readonly notify: (message: string) => void,
  ) {
    this.store = createStore<ApprovalsState>()(() => ({
      auto: EMPTY,
      support: null,
      needsYou: {},
      recent: {},
      flash: {},
      popover: null,
      popoverRecords: null,
      history: null,
      confirm: null,
      approveAll: null,
    }));
  }

  get state(): ApprovalsState {
    return this.store.getState();
  }

  private set(patch: Partial<ApprovalsState> | ((s: ApprovalsState) => Partial<ApprovalsState>)): void {
    this.store.setState(patch);
  }

  private get api() {
    return this.c.api.approvals;
  }

  // ---- 启动和事件 ----

  async start(): Promise<void> {
    const { api } = this.c;
    this.unsubs.push(
      api.on('approval.auto-approve-changed', (e) => {
        this.autoSeq += 1;
        this.set({ auto: e.state });
        this.syncBoard(e.state);
      }),
      api.on('approval.needs-you', (e) =>
        this.set((s) => {
          const { [e.terminalId]: _, ...rest } = s.needsYou;
          return { needsYou: e.reason ? { ...rest, [e.terminalId]: { reason: e.reason, request: e.request } } : rest };
        }),
      ),
      api.on('approval.auto-approved', (e) => {
        const id = e.record.request.terminalId;
        this.set((s) => {
          const recent = [e.record, ...(s.recent[id] ?? [])].slice(0, RECENT_MAX);
          const shown = s.popover ? this.c.windowById(s.popover) : undefined;
          const popoverOpenHere = shown !== undefined && terminalIdOf(shown) === id;
          return {
            recent: { ...s.recent, [id]: recent },
            flash: { ...s.flash, [id]: (s.flash[id] ?? 0) + 1 },
            ...(popoverOpenHere ? { popoverRecords: mergeRecords([e.record], s.popoverRecords ?? []).slice(0, POPOVER_RECORDS) } : {}),
          };
        });
      }),
      this.c.store.subscribe((s) => this.watchTerminalIds(s)),
    );
    this.watchTerminalIds(this.c.state);

    const seq = this.autoSeq;
    const [auto, support, needsYou] = await Promise.all([
      this.api.autoApproveState().catch(() => null),
      this.api.autoApproveSupport().catch(() => null),
      this.api.autoApproveNeedsYou().catch(() => []),
    ]);
    this.set((s) => ({
      // 启动期间已经收到的 auto-approve-changed 比这里新，保留
      ...(auto && seq === this.autoSeq ? { auto } : {}),
      support,
      needsYou: { ...Object.fromEntries(needsYou.map((n) => [n.terminalId, { reason: n.reason, request: n.request }])), ...s.needsYou },
    }));
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.seenTerminalIds.clear();
  }

  /**
   * 终端换了 terminalId（重启、电脑重启后重新打开）：服务不认识新的 id，把这个窗口单独的设置补推过去。
   * 白板刚读出来时看到的 id 不推（apps/desktop 启动时已经按白板恢复过）。
   */
  private watchTerminalIds(s: BoardStoreState): void {
    if (!s.loaded) return;
    for (const w of s.windows) {
      if (!isTerminal(w)) continue;
      const id = terminalIdOf(w);
      const had = this.seenTerminalIds.has(w.id);
      const before = this.seenTerminalIds.get(w.id) ?? null;
      this.seenTerminalIds.set(w.id, id);
      if (!had || id === before || !id) continue;
      const own = (w.data as Partial<TerminalWindowData>).autoApprove;
      if (typeof own === 'boolean') void this.api.setTerminalAutoApprove(id, own).catch(() => undefined);
    }
  }

  /** 服务的开关写进白板（随白板保存）。没变的不动，免得白白存一次。 */
  private syncBoard(auto: AutoApproveState): void {
    const s = this.c.state;
    if (!s.loaded) return;
    let framesChanged = false;
    const frames = s.frames.map((f) => {
      const on = auto.workspaces.some((w) => w.workspaceId === f.workspaceId);
      if (f.autoApprove === on) return f;
      framesChanged = true;
      return { ...f, autoApprove: on };
    });
    let windowsChanged = false;
    const windows = s.windows.map((w) => {
      const id = terminalIdOf(w);
      if (!id) return w;
      const own = auto.terminals.find((t) => t.terminalId === id);
      const value = own ? own.on : null;
      const data = w.data as TerminalWindowData;
      if ((data.autoApprove ?? null) === value) return w;
      windowsChanged = true;
      return { ...w, data: { ...data, autoApprove: value } };
    });
    if (framesChanged || windowsChanged) {
      this.c.store.setState({ ...(framesChanged ? { frames } : {}), ...(windowsChanged ? { windows } : {}) });
    }
  }

  // ---- 查询 ----

  frameOn(ws: WorkspaceId, s: ApprovalsState = this.state): boolean {
    return s.auto.workspaces.some((w) => w.workspaceId === ws);
  }

  /**
   * 这个窗口能不能自动批准（IS-68）：只有 agent 终端，而且服务说这种 agent 支持。
   * shell、自定义命令永远不能；kimi 这类服务报 unsupported 的也不能。框上开着 Auto-approve 只管能的这些，
   * 别的窗口不打钩、不挂书签（包括 Needs you）、没有 since，哪怕服务的开关状态把它算在框里。
   */
  canAutoApprove(w: WindowNode, s: ApprovalsState = this.state): boolean {
    if (!isAgentTerminal(w)) return false;
    const agent = agentOf(w);
    if (!agent) return false;
    const support = this.supportOf(agent, s);
    if (support) return support.method !== 'unsupported';
    return s.support === null ? AUTO_APPROVE_AGENTS.includes(agent) : false;
  }

  /** 这个窗口实际开没开（单独设置优先，其次看它所在的框）。不能自动批准的窗口总是 false。 */
  windowOn(w: WindowNode, s: ApprovalsState = this.state): boolean {
    const id = terminalIdOf(w);
    return id !== null && this.canAutoApprove(w, s) && isAutoApproveOn(s.auto, id, w.workspaceId);
  }

  /** 从什么时候开着。 */
  since(w: WindowNode, s: ApprovalsState = this.state): string | null {
    const id = terminalIdOf(w);
    if (!id || !this.canAutoApprove(w, s)) return null;
    const own = s.auto.terminals.find((t) => t.terminalId === id);
    if (own) return own.on ? own.since : null;
    return s.auto.workspaces.find((x) => x.workspaceId === w.workspaceId)?.since ?? null;
  }

  frameSince(ws: WorkspaceId, s: ApprovalsState = this.state): string | null {
    return s.auto.workspaces.find((x) => x.workspaceId === ws)?.since ?? null;
  }

  supportOf(agent: AgentKind | null, s: ApprovalsState = this.state): AutoApproveSupport | null {
    if (!agent || !s.support) return null;
    return s.support.find((x) => x.agent === agent) ?? null;
  }

  /** 菜单项能不能点；不能时的原因写在菜单项后面。 */
  availability(target: AutoApproveTarget): Availability {
    if (target.kind === 'frame') return { ok: true };
    const w = this.c.windowById(target.windowId);
    if (!w || !isTerminal(w)) return { ok: false, reason: 'Only for terminals' };
    if (!isAgentTerminal(w)) return { ok: false, reason: 'Only for agents' };
    const support = this.supportOf(agentOf(w));
    if (support?.method === 'unsupported') return { ok: false, reason: support.note ?? `Not supported for ${agentOf(w) ?? 'this terminal'}` };
    if (!terminalIdOf(w)) return { ok: false, reason: 'Terminal is not running' };
    return { ok: true };
  }

  isOn(target: AutoApproveTarget): boolean {
    if (target.kind === 'frame') return this.frameOn(target.workspaceId);
    const w = this.c.windowById(target.windowId);
    return w ? this.windowOn(w) : false;
  }

  /** 要你处理的原因（书签变成 Needs you）。终端已经不在等了（服务还没来得及说）就不算。 */
  needsYouOf(w: WindowNode, s: ApprovalsState = this.state, board: BoardStoreState = this.c.state): NeedsYou | null {
    const id = terminalIdOf(w);
    if (!id || !this.windowOn(w, s)) return null;
    const n = s.needsYou[id];
    if (!n) return null;
    const st = board.statuses[id];
    if (st && !WAITING_STATUSES.includes(st.status)) return null;
    return n;
  }

  // ---- 开关 ----

  /** 菜单项：开着就关，关着就开（第一次开先问一句）。 */
  toggle(target: AutoApproveTarget): void {
    if (this.availability(target).ok === false) return;
    if (this.isOn(target)) {
      void this.setOn(target, false);
      return;
    }
    if (!readConfirmed()) {
      this.set({ confirm: target });
      return;
    }
    void this.setOn(target, true);
  }

  confirmTurnOn(): void {
    const target = this.state.confirm;
    if (!target) return;
    writeConfirmed();
    this.set({ confirm: null });
    void this.setOn(target, true);
  }

  cancelConfirm(): void {
    this.set({ confirm: null });
  }

  /**
   * 真正调服务。框：setAutoApprove（会清掉框里终端单独的设置）。
   * 终端：框开着时单独关是 false、再开是 null（跟着框）；框关着时单独开是 true、再关是 null。
   */
  async setOn(target: AutoApproveTarget, on: boolean): Promise<void> {
    try {
      if (target.kind === 'frame') {
        await this.api.setAutoApprove(target.workspaceId, on);
        return;
      }
      const w = this.c.windowById(target.windowId);
      const id = w ? terminalIdOf(w) : null;
      if (!w || !id) return;
      const frameOn = w.workspaceId !== null && this.frameOn(w.workspaceId);
      const value = on === frameOn ? null : on;
      await this.api.setTerminalAutoApprove(id, value);
    } catch (e) {
      this.notify(`Couldn’t turn ${on ? 'on' : 'off'} Auto-approve: ${errorMessage(e)}`);
    }
  }

  // ---- 书签的小卡片 ----

  openPopover(windowId: WindowId): void {
    this.set({ popover: windowId, popoverRecords: null });
    const w = this.c.windowById(windowId);
    const id = w ? terminalIdOf(w) : null;
    if (!w || !id) return;
    void this.recordsFor(w.workspaceId, id, POPOVER_RECORDS).then((records) => {
      if (this.state.popover === windowId) this.set({ popoverRecords: records });
    });
  }

  closePopover(): void {
    if (this.state.popover !== null) this.set({ popover: null, popoverRecords: null });
  }

  // ---- Approval history ----

  /** 框的历史（terminalId 不给），或者一个终端的历史。 */
  openHistory(opts: { workspaceId: WorkspaceId | null; terminalId?: TerminalId | null }): void {
    const terminalId = opts.terminalId ?? null;
    const workspaceId = opts.workspaceId;
    this.set({ history: { workspaceId, terminalId, records: null, error: null }, popover: null, popoverRecords: null });
    const still = () => {
      const h = this.state.history;
      return h !== null && h.workspaceId === workspaceId && h.terminalId === terminalId;
    };
    this.recordsFor(workspaceId, terminalId, HISTORY_LIMIT).then(
      (records) => {
        if (still()) this.set({ history: { workspaceId, terminalId, records, error: null } });
      },
      (e: unknown) => {
        if (still()) this.set({ history: { workspaceId, terminalId, records: [], error: errorMessage(e) } });
      },
    );
  }

  closeHistory(): void {
    this.set({ history: null });
  }

  /** 服务的历史（按工作区）加上这次运行收到的事件，按终端过滤，新的在前。 */
  private async recordsFor(ws: WorkspaceId | null, terminalId: TerminalId | null, limit: number): Promise<ApprovalRecord[]> {
    const fromService = ws ? await this.api.history(ws, limit) : [];
    const local = terminalId
      ? (this.state.recent[terminalId] ?? [])
      : Object.values(this.state.recent).flat().filter((r) => r.request.workspaceId === ws);
    return mergeRecords(fromService, local)
      .filter((r) => terminalId === null || r.request.terminalId === terminalId)
      .slice(0, limit);
  }

  // ---- Approve all（X3） ----

  /** 现在在等“允许一次”的请求（顶栏据此显示 Approve all…）。 */
  approvable(board: BoardStoreState = this.c.state): PendingRequest[] {
    return pendingApprovals(board.windows, board.statuses);
  }

  /** 先列出每条请求，看起来有破坏性的默认不勾。 */
  openApproveAll(): void {
    const board = this.c.state;
    const rows = this.approvable(board).map((request) => ({ request, checked: !request.destructive, outcome: null }));
    this.set({ approveAll: { rows, questions: pendingQuestions(board.windows, board.statuses), busy: false } });
  }

  setRowChecked(id: PendingRequest['id'], checked: boolean): void {
    this.set((s) =>
      s.approveAll
        ? { approveAll: { ...s.approveAll, rows: s.approveAll.rows.map((r) => (r.request.id === id ? { ...r, checked } : r)) } }
        : {},
    );
  }

  closeApproveAll(): void {
    this.set({ approveAll: null });
  }

  /**
   * 批准勾上的。批成的从列表里去掉；没批成的（2 秒内状态没变 couldnt-approve 等）留下来写原因、不勾，留给你；
   * 已经不在等的（gone）直接去掉。全都批成了就关掉，提示一句。
   */
  async approveSelected(): Promise<void> {
    const cur = this.state.approveAll;
    if (!cur || cur.busy) return;
    const chosen = cur.rows.filter((r) => r.checked);
    if (chosen.length === 0) return;
    this.set({ approveAll: { ...cur, busy: true } });
    const ids = chosen.map((r) => r.request.id);
    const includeDestructive = chosen.some((r) => r.request.destructive);
    let results;
    try {
      results = await this.api.approve(ids, { by: 'approve-all', includeDestructive });
    } catch (e) {
      this.notify(`Couldn’t approve: ${errorMessage(e)}`);
      const now = this.state.approveAll;
      if (now) this.set({ approveAll: { ...now, busy: false } });
      return;
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    const ok = results.filter((r) => r.ok).length;
    const now = this.state.approveAll ?? cur;
    const rows = now.rows.flatMap((row): ApproveAllRow[] => {
      const r = byId.get(row.request.id);
      if (!r) return [row];
      if (r.ok || r.reason === 'gone') return [];
      return [{ ...row, checked: false, outcome: r.reason }];
    });
    const failed = rows.some((r) => r.outcome !== null);
    const still = rows.length + now.questions;
    if (ok > 0 || !failed) {
      this.notify(`Approved ${plural(ok, 'request')}${still > 0 ? ` · ${still} still need${still === 1 ? 's' : ''} you` : ''}`);
    }
    if (failed) this.set({ approveAll: { ...now, rows, busy: false } });
    else this.set({ approveAll: null });
  }
}
