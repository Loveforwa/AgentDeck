// Auto-resume 插件（PL6，设计画布“MVP 插件”页 PluginResume，调研 DR-63、DR-84，规则见 docs/plugins.md）在界面这边的状态和纯逻辑。
//
// 2026-10-28 用户定：各家 agent 大多自己会排提示词，要紧的是撞上额度上限那一刻——恢复时把续跑的话发出去，而且你能改这句话、
// 往里加新要求。所以 Prompt queue（PL3）退役，剩下的并进 Auto-resume：
// - 识别、按账号归组、到点错开发送、不让 Mac 睡都在主进程的 LimitService（PL5，agent-adapters 的 limits 模块），界面只读它的列表
//   （limits.list + limits.changed），不自己猜、不自己发按键；
// - 开关：终端 → 框 → 白板（TerminalWindowData.autoResume、FrameNode.autoResume、BoardState.autoResume），默认关，随白板保存，
//   LimitService 每次检查时读白板；在上一级点开关会清掉下一级单独的设置（框上关掉 = 框里的都关，同 Auto-approve 的规矩）；
// - 书签只在这个终端出现在某个受限账号里时挂（开着但没撞上不挂），账号从列表里消失就收起；
// - 卡片里改这一次续跑发的文字：LimitService.setMessage（contracts 0.1.23），预填 LimitedTerminal.defaultMessage。
//
// 这里不碰 React。书签和卡片在 auto-resume.tsx。

import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  AccountLimit,
  AgentDeckApi,
  BoardState,
  FrameNode,
  LimitedTerminal,
  TerminalId,
  TerminalWindowData,
  WindowId,
  WindowNode,
  WorkspaceId,
} from '@agentdeck/contracts';
import { agentOf, isAgentTerminal, terminalIdOf } from '../model/windows.ts';

// ---- 开关 ----

/** 白板上和开关有关的那几样（BoardStoreState 的子集，测试里直接给）。 */
export interface AutoResumeBoard {
  windows: WindowNode[];
  frames: FrameNode[];
  autoResume: boolean;
}

/** 终端自己的设置：true / false 单独设过；null 跟着框。 */
export function ownAutoResume(node: WindowNode | undefined): boolean | null {
  const v = (node?.data as Partial<TerminalWindowData> | null)?.autoResume;
  return typeof v === 'boolean' ? v : null;
}

/** 框上开没开：单独设过的看它，否则跟着白板。 */
export function frameAutoResume(b: AutoResumeBoard, ws: WorkspaceId): boolean {
  const f = b.frames.find((x) => x.workspaceId === ws)?.autoResume;
  return typeof f === 'boolean' ? f : b.autoResume;
}

/** 这个终端的 Auto-resume 开着没有（终端 → 框 → 白板，默认关）。同 agent-adapters 的 effectiveAutoResume。 */
export function windowAutoResume(b: AutoResumeBoard, node: WindowNode | undefined): boolean {
  if (!node || !isAgentTerminal(node)) return false;
  const own = ownAutoResume(node);
  if (own !== null) return own;
  return node.workspaceId ? frameAutoResume(b, node.workspaceId) : b.autoResume;
}

/** 点开关之后的白板：在哪一级点就设哪一级，并清掉下面各级单独的设置（框上关掉 = 框里的都关）。 */
export function toggledAutoResume(
  b: AutoResumeBoard,
  target: { kind: 'window'; windowId: WindowId } | { kind: 'frame'; workspaceId: WorkspaceId } | { kind: 'board' },
): Pick<AutoResumeBoard, 'windows' | 'frames' | 'autoResume'> {
  const clear = (w: WindowNode): WindowNode => {
    if (ownAutoResume(w) === null) return w;
    return { ...w, data: { ...(w.data as TerminalWindowData), autoResume: null } };
  };
  if (target.kind === 'window') {
    const node = b.windows.find((w) => w.id === target.windowId);
    const next = !windowAutoResume(b, node);
    return {
      autoResume: b.autoResume,
      frames: b.frames,
      windows: b.windows.map((w) => (w.id === target.windowId ? { ...w, data: { ...(w.data as TerminalWindowData), autoResume: next } } : w)),
    };
  }
  if (target.kind === 'frame') {
    const next = !frameAutoResume(b, target.workspaceId);
    return {
      autoResume: b.autoResume,
      frames: b.frames.map((f) => (f.workspaceId === target.workspaceId ? { ...f, autoResume: next } : f)),
      windows: b.windows.map((w) => (w.workspaceId === target.workspaceId ? clear(w) : w)),
    };
  }
  return {
    autoResume: !b.autoResume,
    frames: b.frames.map((f) => (typeof f.autoResume === 'boolean' ? { ...f, autoResume: null } : f)),
    windows: b.windows.map(clear),
  };
}

// ---- 时间 ----

/** “3:31pm”；不是今天时前面加 “Oct 29, ”。 */
export function clock(t: number, now: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
  const same = new Date(now).toDateString() === d.toDateString();
  return same ? time : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

const ms = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

// ---- 书签和卡片上写什么 ----

/** 这个终端在 LimitService 里的样子。 */
export interface LimitView {
  account: AccountLimit;
  terminal: LimitedTerminal;
}

export function viewOf(list: readonly AccountLimit[], terminalId: TerminalId | null): LimitView | null {
  if (!terminalId) return null;
  for (const account of list) {
    const terminal = account.terminals.find((t) => t.terminalId === terminalId);
    if (terminal) return { account, terminal };
  }
  return null;
}

export type ResumeTone = 'running' | 'waiting' | 'error' | 'muted';

export interface ResumeLabel {
  tone: ResumeTone;
  /** 书签上的字。 */
  mark: string;
  /** 卡片的状态行，也是书签的悬停。 */
  line: string;
  /** 什么状态（测试、data-state 用）。 */
  state: string;
}

/** 书签和卡片的状态。agent 是终端的 agent（omp 自己处理额度）。 */
export function resumeLabel(view: LimitView, agent: string | null, now: number): ResumeLabel {
  const { account: a, terminal: t } = view;
  const who = agent ?? a.agent;
  const resets = ms(a.resetsAt);
  const resetText = resets !== null ? clock(resets, now) : null;
  const at = ms(t.resumeAt);
  const L = (state: string, tone: ResumeTone, mark: string, line: string): ResumeLabel => ({ state, tone, mark, line });

  if (who === 'omp') return L('omp', 'muted', 'handled by omp', 'omp handles usage limits itself: it switches to another signed-in account or waits for the reset.');
  switch (t.state) {
    case 'resuming':
      return t.owner === 'agent'
        ? L('self-resuming', 'running', `${who} resuming`, `${who} is continuing the task by itself.`)
        : L('resuming', 'running', 'Resuming', `The resume message was sent; ${who} is continuing the task.`);
    case 'resumed':
      return L('resumed', 'muted', 'Resumed', `${who} finished the round after the limit reset.`);
    case 'took-over':
      return L('took-over', 'muted', 'Not resumed · you took over', 'You typed into this terminal after the limit, so Auto-resume leaves it alone.');
    case 'skipped':
      return L('skipped', 'muted', 'Skipped', 'Not resumed this time.');
    case 'handed-off':
      return L('handed-off', 'muted', 'Handed off', 'The crew gave this task to another agent.');
    case 'gave-up':
      return L('gave-up', 'error', 'Hit the limit again', `${who} hit the usage limit again right after resuming. Stopped; resume it yourself when the limit allows.`);
    case 'idle':
      return L(
        'idle',
        'muted',
        resetText ? `Limit · resets ${resetText}` : 'Limit',
        `This account hit its usage limit${resetText ? ` (resets ${resetText})` : ''}. This terminal was idle, so there is nothing to resume.`,
      );
    case 'interrupted':
      break;
  }
  // 被额度打断，还在等
  if (a.needsYou === 'slept') {
    return L('slept', 'waiting', 'Waiting for you', `The Mac was asleep when the limit reset${resetText ? ` at ${resetText}` : ''}. Resume when you are back.`);
  }
  if (t.owner === 'crew') return L('crew', 'muted', 'Crew resumes', 'The crew scheduler resumes this task.');
  if (t.owner === 'run') return L('run', 'muted', 'Day run handles it', 'The day run handles this limit.');
  if (t.owner === 'agent') {
    if (t.selfResume === 'stale' || a.needsYou === 'stale') {
      return L('stale', 'waiting', `${who} waits for Enter`, `${who} is waiting for you to press Enter before it continues.`);
    }
    if (t.selfResume === 'fired') return L('self-resuming', 'running', `${who} resuming`, `${who} is continuing the task by itself.`);
    const edited = t.messageDelivered ? ' It will send your message instead of its own continue.' : '';
    return L(
      'self-waiting',
      'muted',
      resetText ? `${who} resumes ${resetText}` : `${who} resumes by itself`,
      `${who} continues by itself${resetText ? ` at ${resetText}` : ' when the limit resets'}.${edited}`,
    );
  }
  if (resets === null || a.needsYou === 'reset-unknown') {
    return L('reset-unknown', 'waiting', 'Reset time unknown', `${who} didn’t say when the limit resets. Resume now when it allows.`);
  }
  if (t.autoResume === false) {
    return L('off', 'muted', `Limit · resets ${resetText}`, `Auto-resume is off for this terminal. The limit resets at ${resetText}; resume it yourself.`);
  }
  const when = at ?? resets;
  return L('paused', 'waiting', `Paused · resumes ${clock(when, now)}`, `Stopped by the usage limit. Resumes at ${clock(when, now)}, after the limit resets at ${resetText}.`);
}

/** 卡片里能做什么。 */
export interface ResumeActions {
  /** Resume now 能点（恢复时间过了，或者读不到恢复时间）。 */
  resumeNow: boolean;
  /** Resume now 灰掉时的原因。 */
  resumeNowWhy: string | null;
  /** 显示 Don’t resume（只这个终端，LimitService.skip）。 */
  skip: boolean;
  /** Message 能改。 */
  editable: boolean;
  /** 显示 Message（还没续时）。 */
  showMessage: boolean;
}

export function resumeActions(view: LimitView, agent: string | null, now: number, canEdit: boolean): ResumeActions {
  const { account: a, terminal: t } = view;
  const waiting = t.state === 'interrupted';
  const handled = agent === 'omp' || t.owner === 'crew' || t.owner === 'run';
  const resets = ms(a.resetsAt);
  const reached = resets === null || now >= resets;
  const resumeNow = waiting && !handled && reached;
  return {
    resumeNow,
    resumeNowWhy: !waiting || handled ? null : reached ? null : `Available after the limit resets at ${clock(resets!, now)}`,
    skip: waiting && !handled && t.owner !== 'agent',
    editable: waiting && !handled && canEdit && !t.messageDelivered,
    showMessage: waiting && !handled,
  };
}

/** 卡片里的 Message：改过的，否则默认的（服务没给时为空）。 */
export function messageOf(t: LimitedTerminal): string {
  return t.message ?? t.defaultMessage ?? '';
}

// ---- 状态 ----

export interface LimitsState {
  /** LimitService 现在的受限账号（limits.list + limits.changed）。 */
  list: AccountLimit[];
  /** 开着卡片的窗口。 */
  popover: WindowId | null;
}

/**
 * 界面这边的 LimitService 列表（controller.limits，每块白板一个）。书签、卡片、框给书签留的位置都看它。
 * 主进程没有 limits（老版本、假实现没给）时一直是空的。
 */
export class LimitsModel {
  readonly store: StoreApi<LimitsState> = createStore<LimitsState>()(() => ({ list: [], popover: null }));
  private readonly unsubs: (() => void)[] = [];
  private events = 0;

  constructor(
    private readonly api: AgentDeckApi,
    private readonly notify: (message: string) => void,
  ) {}

  get state(): LimitsState {
    return this.store.getState();
  }

  async start(): Promise<void> {
    const api = this.api;
    if (!api.limits) return;
    this.unsubs.push(
      api.on('limits.changed', (e) => {
        this.events += 1;
        this.store.setState({ list: e.limits });
      }),
    );
    const before = this.events;
    const list = await api.limits.list().catch(() => null);
    // 已经来了 limits.changed 的，以事件为准（更新）
    if (list && this.events === before) this.store.setState({ list });
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
  }

  /** 这个窗口的终端在受限账号里的样子；不在为 null。 */
  viewOf(node: WindowNode | undefined, s: LimitsState = this.state): LimitView | null {
    if (!node || !isAgentTerminal(node)) return null;
    return viewOf(s.list, terminalIdOf(node));
  }

  /** 底边挂不挂书签（框要给它留地方）。 */
  marked(node: WindowNode | undefined, s: LimitsState = this.state): boolean {
    return this.viewOf(node, s) !== null;
  }

  openPopover(id: WindowId): void {
    this.store.setState({ popover: id });
  }

  closePopover(): void {
    this.store.setState({ popover: null });
  }

  // ---- 动作（都调服务，结果等 limits.changed 回来） ----

  private run(p: Promise<unknown> | undefined, what: string): Promise<boolean> {
    if (!p) return Promise.resolve(false);
    return p.then(
      () => true,
      (e: unknown) => {
        this.notify(`Couldn’t ${what}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      },
    );
  }

  resumeNow(view: LimitView): Promise<boolean> {
    return this.run(this.api.limits?.resumeNow(view.account.key, [view.terminal.terminalId]), 'resume');
  }

  skip(view: LimitView): Promise<boolean> {
    return this.run(this.api.limits?.skip(view.terminal.terminalId), 'skip this terminal');
  }

  /** 改这一次续跑发的文字；null 回到默认。 */
  setMessage(view: LimitView, text: string | null): Promise<boolean> {
    return this.run(this.api.limits?.setMessage?.(view.terminal.terminalId, text), 'save the message');
  }

  canEditMessage(): boolean {
    return typeof this.api.limits?.setMessage === 'function';
  }
}

/** 这个终端的 agent（书签上写名字用）。 */
export function agentName(node: WindowNode | undefined): string | null {
  return node ? agentOf(node) : null;
}

/** BoardState 里的白板级开关（老数据没有它，按 false）。 */
export function boardAutoResume(b: Partial<Pick<BoardState, 'autoResume'>>): boolean {
  return b.autoResume === true;
}
