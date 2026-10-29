// 终端状态机（StatusService 的真实实现），跑在主进程。
// 需求见「6 · 终端状态与提醒」的“什么时候进入哪个状态”表。输入：
//   - 钩子事件（HookServer → onHook）
//   - TerminalHost 的 terminal.activity / silence / exit / host-lost（onTerminalEvent）
//   - 用户往终端里输入了东西（noteInput，见下面第 15 行）
// 输出：status.changed、agent.turn-end（emit）。
//
// 转换表（编号和 test/status-machine.test.ts 的用例一一对应）：
//
//  #  | 当前状态                       | 输入                          | 结果
// ----+--------------------------------+-------------------------------+---------------------------------------------
//  1  | 未结束                         | exit，退出码 0                | exited
//  2  | 未结束                         | exit，退出码非 0              | error（Error · exit N）
//  3  | 未结束                         | host-lost                     | error（tmux 没了，进程也没了）
//  4  | exited / error                 | 任何输入                      | 不变
//  -- 有钩子的 agent（claude、codex） --
//  5  | starting                       | session-start                 | idle（记下会话 id）
//  6  | running 且这一轮没开始         | session-start                 | idle
//  7  | 其他                           | session-start                 | 不变，只更新会话 id（例如 /clear、compact）；id 变了也发 status.changed
//  8  | 任何                           | prompt-submitted              | running；清掉 pending（批准、回答之后的 PostToolUse 也走这里）
//  8b | needs-*                        | 另一个工具的 PostToolUse      | 不变（claude 会并行跑工具：读文件结束了，Bash 还在等批准）
//  9  | 任何                           | permission-request            | needs-approval，生成 PendingRequest（kind approval，算 destructive）
// 10  | 任何                           | question                      | needs-reply，生成 PendingRequest（kind question）
// 11  | 任何                           | turn-end                      | idle，发 agent.turn-end（已经是空闲且没有在进行的一轮时不重复发）
// 12  | 任何                           | session-end                   | 不变（等 exit）
// 13  | starting                       | activity                      | running（有输出了）
// 14  | running 且这一轮没开始         | silence                       | idle（启动画面画完了，不发 turn-end）
// 15  | running / needs-*，用户输入过  | silence，输入之后没有钩子     | idle，清掉 pending，发 agent.turn-end
//     |                                |                               | （claude 拒绝批准或按 Esc 打断时没有任何钩子，只能这样兜底）
// 16  | idle / needs-* / 这一轮进行中  | activity、silence             | 不变（钩子说了算：TUI 重画、打字都会有输出）
//  -- 没有钩子的程序（Shell、自定义命令、旧版 agent） --
// 17  | starting / idle                | activity                      | running
// 18  | running                        | silence                       | idle（不发 agent.turn-end，避免 dev server 每次停下都刷新面板）
// 19  | 任何                           | 钩子事件                      | 照有钩子的规则处理（例如旧版 codex 的 notify 发来的 turn-end）
//
// “这一轮开始”指收到 prompt-submitted / permission-request / question，turn-end 时结束。
//
//  -- 钩子没来（AH3，IS-74）--
// 20  | 有钩子，track 时 watchHooks 是 startup（claude、pi、omp：一启动就有 SessionStart）| 10 秒内没有任何钩子
//     |                                |                               | 改按没有钩子的规则（17、18）判断，StatusSnapshot.degraded 写原因，告诉 onDegraded
// 21  | 有钩子，watchHooks 是 first-input（codex：SessionStart 要等第一次输入）| 第一次输入后 10 秒内没有钩子 | 同 20
// 22  | 第 20、21 行降级之后            | 钩子又来了                    | 回到有钩子的规则，degraded 清掉
// 23  | track 时给了 degraded（没有钩子的 agent、只带会话参数重开的）| — | 快照一直带着这句（状态灯悬停写它）
//
//  -- 信任提示（IS-06）：claude 第一次在某个目录启动先问信任不信任，这时还没有任何钩子 --
// 24  | 有钩子、还没收到过钩子          | silence，屏幕上是信任提示      | needs-reply（Trust this folder?），暂停第 20 行的计时
// 25  | 第 24 行之后                    | 任何钩子（一般是 session-start）| 先回到 idle，再按这条钩子的规则走
// 26  | 第 24 行之后，还没有钩子        | silence，提示不在屏幕上了      | idle，重新开始第 20 行的计时

import { WAITING_STATUSES } from '@agentdeck/contracts';
import type {
  AgentHookEvent,
  AgentKind,
  AgentSessionId,
  PendingRequest,
  RequestId,
  StatusEvent,
  StatusService,
  StatusSnapshot,
  TerminalEvent,
  TerminalId,
  TerminalStatus,
  WorkspaceId,
} from '@agentdeck/contracts';
import { compilePatterns, isDestructive } from './destructive.ts';
import { TRUST_PROMPT_AGENTS, matchTrustPrompt } from './screens.ts';

export interface TrackOptions {
  agent: AgentKind;
  workspaceId: WorkspaceId | null;
  /** 这个终端的 agent 有没有接上钩子。 */
  hooks: boolean;
  /** 重开应用时接上已经在跑的终端可以给 'idle' 之类；默认 starting。 */
  status?: TerminalStatus;
  sessionId?: AgentSessionId | null;
  /**
   * AH3（IS-74）：钩子什么时候该来。startup：启动后 hookTimeoutMs 内（claude、pi、omp 一启动就报 SessionStart）；
   * first-input：第一次 noteInput 之后 hookTimeoutMs 内（codex 的 SessionStart 要等第一次输入）。没来就退回按输出判断（第 20、21 行）。
   * 不给时不看（重开应用接回的终端、测试）。
   */
  watchHooks?: 'startup' | 'first-input' | null;
  /** 一开始就退回按输出判断的原因（第 23 行），例如 "Status from terminal activity · Kimi has no hooks"。 */
  degraded?: string | null;
}

/** 钩子该来没来时快照里写的原因（contracts StatusSnapshot.degraded 的例子）。 */
export const HOOKS_DIDNT_REPORT = "Hooks didn't report · status from terminal activity";

export interface TrackedTerminal {
  terminalId: TerminalId;
  agent: AgentKind;
  workspaceId: WorkspaceId | null;
  status: TerminalStatus;
  pending: PendingRequest | null;
}

/** 钩子事件之外的线索，由 hookHint() 从原始负载里取。 */
export interface HookHint {
  /** 这是某个工具跑完（PostToolUse），值是它的 summary，和 PendingRequest.summary 的算法相同。 */
  afterTool?: string | null;
}

export interface StatusMachineOptions {
  emit: (event: StatusEvent) => void;
  /** AH3：钩子该来没来、退回按输出判断时（第 20、21 行）。AgentService 记下来写进能力报告（“Hooks didn't report at the last launch”）。 */
  onDegraded?: (d: { terminalId: TerminalId; agent: AgentKind; reason: string }) => void;
  /** AH3：一个终端第一次收到钩子（钩子活着）。AgentService 据此清掉报告里 “上次钩子没来” 的说明。 */
  onHooksAlive?: (d: { terminalId: TerminalId; agent: AgentKind }) => void;
  /** 钩子最多等多久（毫秒），默认 10000。 */
  hookTimeoutMs?: number;
  /** Settings › Approvals 的破坏性名单（正则字符串）。每次判断时取，改设置立即生效。 */
  destructivePatterns: () => readonly string[];
  /** 读终端屏幕最后几行（TerminalHost.lastLines）。第 24–26 行用；不给时不认信任提示。 */
  screen?: (terminalId: TerminalId) => Promise<readonly string[]>;
  now?: () => Date;
}

interface Entry {
  agent: AgentKind;
  workspaceId: WorkspaceId | null;
  hooks: boolean;
  sessionId: AgentSessionId | null;
  snap: StatusSnapshot;
  /** 这一轮开始了还没结束。 */
  turnActive: boolean;
  /** 用户输入过、之后还没收到任何钩子（第 15 行）。 */
  inputSinceHook: boolean;
  /** 第 20–23 行。 */
  watch: 'startup' | 'first-input' | null;
  sawHook: boolean;
  hookTimer: ReturnType<typeof setTimeout> | null;
  /** 钩子没来被降级了（第 22 行据此恢复）。 */
  hookFailed: boolean;
  degraded: string | null;
  /** 第 24 行：屏幕上是信任提示时的那条 pending。 */
  trust: PendingRequest | null;
}

const ENDED: readonly TerminalStatus[] = ['exited', 'error'];
/** 还没 track 的终端先到的钩子留多久（毫秒）：SessionStart 可能比 TerminalHost.create 返回还早。 */
const EARLY_HOOK_TTL_MS = 10_000;

export class StatusMachine implements StatusService {
  private readonly entries = new Map<TerminalId, Entry>();
  private readonly now: () => Date;
  private nextRequest = 1;
  private patternsSource: readonly string[] | null = null;
  private patterns: RegExp[] = [];
  private readonly early = new Map<TerminalId, { event: AgentHookEvent | null; hint: HookHint; at: number }[]>();
  private readonly hookTimeoutMs: number;

  constructor(private readonly opts: StatusMachineOptions) {
    this.now = opts.now ?? (() => new Date());
    this.hookTimeoutMs = opts.hookTimeoutMs ?? 10_000;
  }

  async snapshot(): Promise<StatusSnapshot[]> {
    return [...this.entries.values()].map((e) => structuredClone(e.snap));
  }

  // ---- 输入 ----

  /** 开始跟踪一个终端（AgentService.onStarted，或重开应用时接上已有终端）。 */
  track(terminalId: TerminalId, t: TrackOptions): void {
    const status = t.status ?? 'starting';
    this.stopWatch(this.entries.get(terminalId));
    const degraded = t.degraded ?? null;
    const e: Entry = {
      agent: t.agent,
      workspaceId: t.workspaceId,
      hooks: t.hooks,
      sessionId: t.sessionId ?? null,
      snap: {
        terminalId,
        status,
        since: this.iso(),
        exitCode: null,
        pending: null,
        ...(t.sessionId ? { sessionId: t.sessionId } : {}),
        ...(degraded ? { degraded } : {}),
      },
      turnActive: false,
      inputSinceHook: false,
      watch: t.hooks ? (t.watchHooks ?? null) : null,
      sawHook: false,
      hookTimer: null,
      hookFailed: false,
      degraded,
      trust: null,
    };
    this.entries.set(terminalId, e);
    if (e.watch === 'startup') this.startWatch(terminalId, e); // 20
    this.emitStatus(terminalId);
    const early = this.early.get(terminalId);
    this.early.delete(terminalId);
    for (const h of early ?? []) this.onHook(terminalId, h.event, h.hint);
  }

  /** 窗口关了、终端也结束了，不再需要它的状态。 */
  forget(terminalId: TerminalId): void {
    this.stopWatch(this.entries.get(terminalId));
    this.entries.delete(terminalId);
  }

  onHook(terminalId: TerminalId, event: AgentHookEvent | null, hint: HookHint = {}): void {
    const e = this.entries.get(terminalId);
    if (!e) {
      this.keepEarly(terminalId, event, hint);
      return;
    }
    if (this.ended(e)) return; // 4
    e.inputSinceHook = false;
    if (!e.sawHook && e.watch !== null) this.opts.onHooksAlive?.({ terminalId, agent: e.agent });
    e.sawHook = true;
    this.stopWatch(e);
    if (e.trust) {
      // 25：点了信任，钩子来了
      e.trust = null;
      if (e.snap.status === 'needs-reply') this.set(terminalId, e, 'idle');
    }
    if (e.hookFailed) {
      // 22：钩子来晚了，回到有钩子的规则
      e.hookFailed = false;
      e.hooks = true;
      e.degraded = null;
      const { degraded: _gone, ...rest } = e.snap;
      e.snap = rest;
      this.emitStatus(terminalId);
    }
    if (!event) return;
    switch (event.type) {
      case 'session-start':
        e.sessionId = event.sessionId;
        if (e.snap.status === 'starting' || (e.snap.status === 'running' && !e.turnActive)) this.set(terminalId, e, 'idle'); // 5 6
        // 7：状态不变也要把新的会话 id 发出去（codex、omp 启动时不知道 id，/clear 之后 id 也会变）
        if (e.snap.sessionId !== e.sessionId) {
          e.snap = { ...e.snap, sessionId: e.sessionId };
          this.emitStatus(terminalId);
        }
        return;
      case 'prompt-submitted': {
        const pending = e.snap.pending;
        if (pending && hint.afterTool != null && hint.afterTool !== pending.summary) return; // 8b
        e.turnActive = true;
        this.set(terminalId, e, 'running'); // 8
        return;
      }
      case 'permission-request':
        e.turnActive = true;
        this.set(terminalId, e, 'needs-approval', this.pending(terminalId, e, 'approval', event.summary, event.command)); // 9
        return;
      case 'question':
        e.turnActive = true;
        this.set(terminalId, e, 'needs-reply', this.pending(terminalId, e, 'question', event.summary, null)); // 10
        return;
      case 'turn-end':
        this.endTurn(terminalId, e); // 11
        return;
      case 'session-end':
        return; // 12
    }
  }

  onTerminalEvent(event: TerminalEvent): void {
    switch (event.type) {
      case 'terminal.exit': {
        const e = this.entries.get(event.id);
        if (!e || this.ended(e)) return; // 4
        e.turnActive = false;
        this.stopWatch(e);
        this.set(event.id, e, event.code === 0 ? 'exited' : 'error', null, event.code); // 1 2
        return;
      }
      case 'terminal.host-lost':
        for (const [id, e] of this.entries) {
          if (this.ended(e)) continue;
          e.turnActive = false;
          this.stopWatch(e);
          this.set(id, e, 'error'); // 3
        }
        return;
      case 'terminal.activity': {
        const e = this.entries.get(event.id);
        if (!e || this.ended(e)) return;
        const s = e.snap.status;
        if (e.hooks) {
          if (s === 'starting') this.set(event.id, e, 'running'); // 13
          return; // 16
        }
        if (s === 'starting' || s === 'idle') this.set(event.id, e, 'running'); // 17
        return;
      }
      case 'terminal.silence': {
        const e = this.entries.get(event.id);
        if (!e || this.ended(e)) return;
        const s = e.snap.status;
        if (e.hooks) {
          if (e.inputSinceHook && (s === 'running' || WAITING_STATUSES.includes(s))) {
            e.inputSinceHook = false;
            this.endTurn(event.id, e); // 15
          } else if (s === 'running' && !e.turnActive) {
            this.set(event.id, e, 'idle'); // 14
          }
          if (!e.sawHook && this.opts.screen && TRUST_PROMPT_AGENTS.includes(e.agent)) void this.checkTrust(event.id, e); // 24 26
          return; // 16
        }
        if (s === 'running') this.set(event.id, e, 'idle'); // 18
        return;
      }
      case 'terminal.link':
        return;
    }
  }

  /**
   * 用户往这个终端输入了东西（terminals.write、批准时的 sendKeys）。组装时由 IPC 层调用。
   * 只用来兜底第 15 行：claude 拒绝批准、按 Esc 打断都不触发任何钩子。
   */
  noteInput(terminalId: TerminalId): void {
    const e = this.entries.get(terminalId);
    if (e && e.hooks && !this.ended(e)) {
      e.inputSinceHook = true;
      if (e.watch === 'first-input' && !e.sawHook && !e.hookTimer) this.startWatch(terminalId, e); // 21
    }
  }

  // ---- 给组装和 ApprovalService 用 ----

  get(terminalId: TerminalId): (StatusSnapshot & { agent: AgentKind; workspaceId: WorkspaceId | null; sessionId: AgentSessionId | null }) | null {
    const e = this.entries.get(terminalId);
    return e ? { ...structuredClone(e.snap), agent: e.agent, workspaceId: e.workspaceId, sessionId: e.sessionId } : null;
  }

  /** 所有在等你的请求。 */
  pendingRequests(): PendingRequest[] {
    return [...this.entries.values()].flatMap((e) => (e.snap.pending ? [structuredClone(e.snap.pending)] : []));
  }

  /** 所有在跟踪的终端（ApprovalService 用：框里有哪些终端、哪些要看屏幕）。 */
  tracked(): TrackedTerminal[] {
    return [...this.entries].map(([terminalId, e]) => ({
      terminalId,
      agent: e.agent,
      workspaceId: e.workspaceId,
      status: e.snap.status,
      pending: e.snap.pending ? structuredClone(e.snap.pending) : null,
    }));
  }

  // ---- 内部 ----

  /** 第 20、21 行：hookTimeoutMs 内没有任何钩子就退回按输出判断。 */
  /** 第 24、26 行：还没收到钩子、屏幕停下时看一眼是不是信任提示。 */
  private async checkTrust(terminalId: TerminalId, e: Entry): Promise<void> {
    let lines: readonly string[];
    try {
      lines = await this.opts.screen!(terminalId);
    } catch {
      return;
    }
    if (this.entries.get(terminalId) !== e || this.ended(e) || e.sawHook) return;
    const summary = matchTrustPrompt(e.agent, lines);
    if (summary) {
      if (e.trust) return;
      // 等你点信任时钩子本来就不会来，不算钩子坏了
      this.stopWatch(e);
      e.trust = this.pending(terminalId, e, 'question', summary, null);
      this.set(terminalId, e, 'needs-reply', e.trust); // 24
    } else if (e.trust) {
      e.trust = null;
      this.set(terminalId, e, 'idle'); // 26
      if (e.watch === 'startup') this.startWatch(terminalId, e);
    }
  }

  private startWatch(terminalId: TerminalId, e: Entry): void {
    this.stopWatch(e);
    e.hookTimer = setTimeout(() => {
      e.hookTimer = null;
      if (this.entries.get(terminalId) !== e || this.ended(e) || e.sawHook) return;
      e.hooks = false;
      e.hookFailed = true;
      e.inputSinceHook = false;
      e.degraded = HOOKS_DIDNT_REPORT;
      e.snap = { ...e.snap, degraded: HOOKS_DIDNT_REPORT };
      this.emitStatus(terminalId);
      this.opts.onDegraded?.({ terminalId, agent: e.agent, reason: HOOKS_DIDNT_REPORT });
    }, this.hookTimeoutMs);
    e.hookTimer.unref?.();
  }

  private stopWatch(e: Entry | undefined): void {
    if (e?.hookTimer) {
      clearTimeout(e.hookTimer);
      e.hookTimer = null;
    }
  }

  private keepEarly(terminalId: TerminalId, event: AgentHookEvent | null, hint: HookHint): void {
    const t = this.now().getTime();
    for (const [id, list] of this.early) {
      const fresh = list.filter((h) => t - h.at < EARLY_HOOK_TTL_MS);
      if (fresh.length) this.early.set(id, fresh);
      else this.early.delete(id);
    }
    const list = this.early.get(terminalId) ?? [];
    list.push({ event, hint, at: t });
    this.early.set(terminalId, list);
  }

  private endTurn(terminalId: TerminalId, e: Entry): void {
    const wasActive = e.turnActive || e.snap.status !== 'idle';
    e.turnActive = false;
    this.set(terminalId, e, 'idle');
    if (wasActive) this.opts.emit({ type: 'agent.turn-end', terminalId, workspaceId: e.workspaceId });
  }

  private ended(e: Entry): boolean {
    return ENDED.includes(e.snap.status);
  }

  /** 改状态。状态和 pending 都没变时不发事件；离开等待状态时 pending 清掉。 */
  private set(
    terminalId: TerminalId,
    e: Entry,
    status: TerminalStatus,
    pending: PendingRequest | null = null,
    exitCode: number | null = e.snap.exitCode,
  ): void {
    const prev = e.snap;
    if (prev.status === status && prev.pending?.id === pending?.id && prev.exitCode === exitCode) return;
    e.snap = {
      terminalId,
      status,
      since: prev.status === status && prev.pending?.id === pending?.id ? prev.since : this.iso(),
      exitCode,
      pending,
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      ...(e.degraded ? { degraded: e.degraded } : {}),
    };
    this.emitStatus(terminalId);
  }

  private pending(
    terminalId: TerminalId,
    e: Entry,
    kind: PendingRequest['kind'],
    summary: string,
    command: string | null,
  ): PendingRequest {
    return {
      id: `req-${this.nextRequest++}` as RequestId,
      terminalId,
      workspaceId: e.workspaceId,
      agent: e.agent,
      kind,
      summary,
      command,
      destructive: kind === 'approval' && isDestructive(this.compiledPatterns(), command, summary),
      at: this.iso(),
    };
  }

  private compiledPatterns(): RegExp[] {
    const src = this.opts.destructivePatterns();
    if (src !== this.patternsSource) {
      this.patternsSource = src;
      this.patterns = compilePatterns(src);
    }
    return this.patterns;
  }

  private emitStatus(terminalId: TerminalId): void {
    const e = this.entries.get(terminalId);
    if (e) this.opts.emit({ type: 'status.changed', snapshot: structuredClone(e.snap) });
  }

  private iso(): string {
    return this.now().toISOString();
  }
}
