// Prompt queue 插件（PL3，设计画布“MVP 插件”页 PluginQueue，调研 DR-63，规则见 docs/plugins.md）。
// 贴在 agent 终端上（claude、codex；别的 agent 灰掉，shell 和自定义命令不列）。你预先排好提示词；这个终端的 agent 碰到
// 额度上限后，到了记录里的恢复时间 + 1 分钟、agent 空闲时发第一条，之后它每做完一轮（回到空闲）发下一条，又碰到上限就
// 等下一次恢复，发完为止（2026-10-27 用户定：只在上限后发）。
//
// - 队列存在 TerminalWindowData.queue，随白板保存；重开应用后接着等、接着发。
// - QueueRunner（每块白板一个，PluginDefinition.start 起）：对开着队列的终端 usage.watch(owner 'prompt-queue') 拿
//   TerminalUsage.limit，按 decide 发；发的时候 bracketed paste 送文字、再发回车。在等恢复或正在接着发、开着 Keep Mac awake
//   时让 app.setKeepAwake(true)。
// - IS-113：碰到上限记成 armed 存进队列（limit 被成功的请求清掉也不忘，发完第一条才清）；claude ≥ 2.1.234 自己会续跑，
//   恢复后先等它续的那一轮做完再发，3 分钟没动静才按原规则发，它在等回车（stale）时不粘贴（见 queue-model 的 decide）。
// - 书签挂在终端底边左侧，排在 Auto-approve 书签后面；点开卡片写、排、删提示词，Send next now、Pause、Keep Mac awake。

import { useLayoutEffect, useRef, useState } from 'react';
import type { PromptQueueSettings, TerminalId, TerminalStatus, UsageLimit, WindowId, WindowNode } from '@agentdeck/contracts';
import { Button, Popover } from '@agentdeck/ui-kit';
import type { BoardController } from '../controller.ts';
import { agentOf, isAgentTerminal, terminalIdOf } from '../model/windows.ts';
import { useApprovals, useBoardState, useController } from '../react/context.tsx';
import {
  QUEUE_AGENTS,
  START_TIMEOUT_MS,
  addPrompt,
  armedFrom,
  clock,
  decide,
  movePrompt,
  pasteKeys,
  queueLabel,
  queueSettings,
  removePrompt,
  selfResumes,
  takeFirst,
  trackSelfResume,
  type SelfResume,
} from './queue-model.ts';
import type { PluginDefinition } from './types.ts';

const OWNER = 'prompt-queue';

/** 改这个终端的队列（写进窗口数据，白板负责保存）。 */
export function setQueue(c: BoardController, windowId: WindowId, next: PromptQueueSettings | ((q: PromptQueueSettings) => PromptQueueSettings)): void {
  const cur = queueSettings(c.windowById(windowId));
  c.updateData(windowId, { queue: typeof next === 'function' ? next(cur) : next });
}

// ---- 发送 ----

/** 每块白板一个：看着开了队列的终端，到点就发。 */
export class QueueRunner {
  private readonly limits = new Map<TerminalId, UsageLimit | null>();
  private readonly watched = new Set<TerminalId>();
  /** 已经拿到第一次用量（知道有没有碰到上限）的终端。拿到之前不发：重开应用时 running 还是 true，不能抢在读到上限之前发。 */
  private readonly ready = new Set<TerminalId>();
  /** 刚发出去、还没看到 agent 开始干活的：发出的时间，以及有没有看到过它离开 idle。 */
  private readonly inFlight = new Map<TerminalId, { at: number; started: boolean }>();
  /** agent 自己会续跑的终端：这一次恢复前后看到的情况（IS-113）。 */
  private readonly resumes = new Map<TerminalId, SelfResume>();
  /** 上一次检查的时间：隔太久说明中间没看着（电脑睡了、应用关着），见 trackSelfResume。 */
  private lastTick: number | null = null;
  private readonly unsubs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private awake = false;
  private busy = false;
  /** reconcile 里改窗口数据会同步触发 store 订阅：不重入，做完再补一次。 */
  private reconciling = false;
  private again = false;

  constructor(
    private readonly c: BoardController,
    private readonly now: () => number = Date.now,
  ) {}

  start(): () => void {
    this.unsubs.push(
      this.c.store.subscribe(() => this.reconcile()),
      this.c.api.on('usage.changed', (e) => {
        if (!this.watched.has(e.usage.terminalId)) return;
        this.limits.set(e.usage.terminalId, e.usage.limit ?? null);
        this.reconcile();
      }),
    );
    // 恢复时间是“到点”，没有事件：每 5 秒看一次
    this.timer = setInterval(() => this.reconcile(), 5000);
    this.reconcile();
    return () => this.stop();
  }

  stop(): void {
    for (const u of this.unsubs.splice(0)) u();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const tid of this.watched) void this.c.api.usage.unwatch(tid, OWNER).catch(() => undefined);
    this.watched.clear();
    this.ready.clear();
    this.resumes.clear();
    this.lastTick = null;
    if (this.awake) void this.c.api.app.setKeepAwake(false).catch(() => undefined);
    this.awake = false;
  }

  limitOf(terminalId: TerminalId | null): UsageLimit | null {
    return terminalId ? (this.limits.get(terminalId) ?? null) : null;
  }

  /** agent 自己续跑时看到的情况（书签用）；没有为 null。 */
  selfResumeOf(terminalId: TerminalId | null): SelfResume | null {
    return terminalId ? (this.resumes.get(terminalId) ?? null) : null;
  }

  /** 这个终端的 agent 会不会在额度恢复后自己续跑（claude ≥ 2.1.234）。 */
  selfResumes(w: WindowNode): boolean {
    const agent = agentOf(w);
    return selfResumes(agent, this.c.state.agents.find((a) => a.id === agent)?.version ?? null);
  }

  /** 开着队列的 agent 终端。 */
  private queued(): { w: WindowNode; tid: TerminalId; q: PromptQueueSettings }[] {
    const out: { w: WindowNode; tid: TerminalId; q: PromptQueueSettings }[] = [];
    for (const w of this.c.state.windows) {
      const tid = terminalIdOf(w);
      const q = queueSettings(w);
      if (tid && q.on && isAgentTerminal(w)) out.push({ w, tid, q });
    }
    return out;
  }

  reconcile(): void {
    if (this.busy || !this.c.state.loaded) return;
    if (this.reconciling) {
      this.again = true;
      return;
    }
    this.reconciling = true;
    try {
      do {
        this.again = false;
        this.reconcileOnce();
      } while (this.again);
    } finally {
      this.reconciling = false;
    }
  }

  private reconcileOnce(): void {
    const list = this.queued();
    const live = new Set(list.map((x) => x.tid));
    for (const tid of [...this.watched]) {
      if (live.has(tid)) continue;
      this.watched.delete(tid);
      this.ready.delete(tid);
      this.limits.delete(tid);
      this.inFlight.delete(tid);
      this.resumes.delete(tid);
      void this.c.api.usage.unwatch(tid, OWNER).catch(() => undefined);
    }
    for (const { tid } of list) {
      if (this.watched.has(tid)) continue;
      this.watched.add(tid);
      void this.c.api.usage.watch(tid, OWNER).then(
        (u) => {
          if (!this.watched.has(tid)) return;
          this.limits.set(tid, u.limit ?? null);
          this.ready.add(tid);
          this.reconcile();
        },
        () => undefined,
      );
    }
    const now = this.now();
    const prevTick = this.lastTick;
    this.lastTick = now;
    let wantAwake = false;
    for (const { w, tid, q: saved } of list) {
      const status = this.c.state.statuses[tid]?.status ?? null;
      const limit = this.limits.get(tid) ?? null;
      const f = this.inFlight.get(tid);
      if (f) {
        if (status !== null && status !== 'idle') f.started = true;
        // 它开始干活又回到空闲了，或者一直没开始（超时）：这一条算完
        if ((f.started && status === 'idle') || now - f.at > START_TIMEOUT_MS) this.inFlight.delete(tid);
      }
      const ready = this.ready.has(tid);
      // 碰到上限就记下（armed，IS-113）：之后 limit 被成功的请求清掉也不忘
      const armed = ready ? armedFrom(saved, limit) : (saved.armed ?? null);
      const sr = this.selfResumes(w) ? trackSelfResume(this.resumes.get(tid) ?? null, armed, status, now, prevTick) : null;
      if (sr) this.resumes.set(tid, sr);
      else this.resumes.delete(tid);
      if (!ready) continue;
      let q = saved;
      if (armed !== (saved.armed ?? null)) {
        q = { ...saved, armed };
        setQueue(this.c, w.id, q);
      }
      const d = decide({ q, limit, status, now, inFlight: this.inFlight.has(tid), selfResume: sr });
      if (d.kind === 'stop-running') setQueue(this.c, w.id, { ...q, running: false });
      else if (d.kind === 'send') void this.send(w.id, tid, d.running);
      if (q.keepAwake && !q.paused && q.prompts.length > 0 && (armed !== null || q.running)) wantAwake = true;
    }
    if (wantAwake !== this.awake) {
      this.awake = wantAwake;
      void this.c.api.app.setKeepAwake(wantAwake).catch(() => undefined);
    }
  }

  /** 发第一条（Send next now 也走这里，running 为 false：只发一条，不开始接着发）。 */
  async send(windowId: WindowId, tid: TerminalId, running: boolean): Promise<boolean> {
    const w = this.c.windowById(windowId);
    if (!w || this.inFlight.has(tid)) return false;
    const before = queueSettings(w);
    const { q, prompt } = takeFirst(before, new Date(this.now()).toISOString(), running);
    if (!prompt) return false;
    this.inFlight.set(tid, { at: this.now(), started: false });
    this.busy = true;
    try {
      setQueue(this.c, windowId, q);
    } finally {
      this.busy = false;
    }
    // 发完这条可能就空了（Keep Mac awake 要放开）：马上再看一次
    queueMicrotask(() => this.reconcile());
    try {
      await this.c.api.terminals.sendKeys(tid, [pasteKeys(prompt.text)]);
      // 让 TUI 先把粘贴收进输入框，再回车提交
      await new Promise((r) => setTimeout(r, 250));
      await this.c.api.terminals.sendKeys(tid, ['Enter']);
      return true;
    } catch {
      // 没发出去：放回队首，别丢；记下的上限也放回去
      setQueue(this.c, windowId, (cur) => ({ ...cur, prompts: [prompt, ...cur.prompts], sent: cur.sent.slice(0, -1), armed: cur.armed ?? before.armed ?? null }));
      this.inFlight.delete(tid);
      return false;
    }
  }
}

const runners = new WeakMap<BoardController, QueueRunner>();

export function queueRunner(c: BoardController): QueueRunner | undefined {
  return runners.get(c);
}

export const queuePlugin: PluginDefinition = {
  id: 'prompt-queue',
  label: 'Prompt queue',
  attachesTo: ['terminal'],
  agents: QUEUE_AGENTS,
  agentsOnly: true,
  isOn: (c, t) => t.kind === 'window' && queueSettings(c.windowById(t.windowId)).on,
  toggle: (c, t) => {
    if (t.kind !== 'window') return;
    const cur = queueSettings(c.windowById(t.windowId));
    setQueue(c, t.windowId, { ...cur, on: !cur.on, running: false });
  },
  start: (c) => {
    const r = new QueueRunner(c);
    runners.set(c, r);
    const stop = r.start();
    return () => {
      stop();
      runners.delete(c);
    };
  },
  WindowMark: QueueMark,
};

// ---- 书签和卡片 ----

/** 终端底边左侧的书签，排在 Auto-approve 书签后面。没开时不画。 */
export function QueueMark({ windowId }: { windowId: WindowId }) {
  const c = useController();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const node = useBoardState((s) => s.windows.find((w) => w.id === windowId));
  const tid = node ? terminalIdOf(node) : null;
  const status = useBoardState((s) => (tid ? (s.statuses[tid]?.status ?? null) : null));
  // 书签上的时间每 30 秒刷新一次，usage.changed 来了也刷新
  const [, tick] = useState(0);
  useLayoutEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    const off = c.api.on('usage.changed', (e) => {
      if (e.usage.terminalId === tid) tick((n) => n + 1);
    });
    return () => {
      clearInterval(t);
      off();
    };
  }, [c, tid]);
  // Auto-approve 书签开着时排在它后面：量它的右边
  const aaOn = useApprovals((s) => (node ? c.approvals.windowOn(node, s) : false));
  const aaNeeds = useApprovals((s) => (tid ? (s.needsYou[tid] ?? null) : null));
  useLayoutEffect(() => {
    const el = ref.current;
    const aa = el?.parentElement?.querySelector<HTMLElement>('.ad-auto-approve-mark');
    setLeft(aa ? aa.offsetLeft + aa.offsetWidth + 4 : null);
  }, [aaOn, aaNeeds, node?.data]);
  if (!node || !isAgentTerminal(node)) return null;
  const q = queueSettings(node);
  if (!q.on) return null;
  const agent = agentOf(node) ?? 'the agent';
  const runner = queueRunner(c);
  const limit = runner?.limitOf(tid) ?? null;
  const label = queueLabel(q, limit, status, agent, Date.now(), {
    selfResumes: runner?.selfResumes(node) ?? false,
    selfResume: runner?.selfResumeOf(tid) ?? null,
  });
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="ad-plugin-mark ad-queue-mark nopan nodrag nowheel"
        data-plugin="prompt-queue"
        data-tone={label.tone}
        style={left !== null ? { left } : undefined}
        title={label.line}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onContextMenu={(e) => e.stopPropagation()}
      >
        {label.tone !== 'muted' ? <span className={`ad-queue-lamp ad-queue-lamp--${label.tone}`} aria-hidden="true" /> : null}
        {label.mark}
      </button>
      <Popover open={open} anchor={ref} placement="bottom-start" role="dialog" aria-label="Prompt queue" onClose={() => setOpen(false)} className="ad-queue-card">
        <QueueCard windowId={windowId} q={q} line={label.line} tone={label.tone} status={status} agent={agent} limit={limit} />
      </Popover>
    </>
  );
}

function QueueCard(props: {
  windowId: WindowId;
  q: PromptQueueSettings;
  line: string;
  tone: string;
  status: TerminalStatus | null;
  agent: string;
  limit: UsageLimit | null;
}) {
  const c = useController();
  const { windowId, q, status } = props;
  const [draft, setDraft] = useState('');
  const node = c.windowById(windowId);
  const tid = node ? terminalIdOf(node) : null;
  const add = () => {
    if (!draft.trim()) return;
    setQueue(c, windowId, (cur) => addPrompt(cur, draft));
    setDraft('');
  };
  const canSendNow = status === 'idle' && q.prompts.length > 0 && tid !== null;
  return (
    <div className="ad-queue-card-body">
      <div className="ad-queue-card-head">
        <b>Prompt queue</b>
        <span className="ad-queue-muted">· {q.prompts.length === 1 ? '1 prompt' : `${q.prompts.length} prompts`}</span>
      </div>
      <p className="ad-queue-line" data-tone={props.tone}>
        {props.line}
      </p>
      {q.prompts.length > 0 ? (
        <ol className="ad-queue-list" aria-label="Queued prompts">
          {q.prompts.map((p, i) => (
            <li key={p.id} className="ad-queue-item">
              <span className="ad-queue-n">{i + 1}</span>
              <span className="ad-queue-text">{p.text}</span>
              <span className="ad-queue-actions">
                <button type="button" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => setQueue(c, windowId, (cur) => movePrompt(cur, p.id, -1))}>
                  ↑
                </button>
                <button type="button" aria-label="Move down" title="Move down" disabled={i === q.prompts.length - 1} onClick={() => setQueue(c, windowId, (cur) => movePrompt(cur, p.id, 1))}>
                  ↓
                </button>
                <button type="button" aria-label="Remove" title="Remove" onClick={() => setQueue(c, windowId, (cur) => removePrompt(cur, p.id))}>
                  ×
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="ad-queue-add">
        <textarea
          className="nokey"
          value={draft}
          rows={2}
          placeholder="Add a prompt… (⌘↩ to add)"
          aria-label="New prompt"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" disabled={!draft.trim()} onClick={add}>
          Add
        </Button>
      </div>
      <div className="ad-queue-foot">
        <Button
          size="sm"
          disabled={!canSendNow}
          title={canSendNow ? 'Send the next prompt now, without waiting for the limit' : `Available when ${props.agent} is idle`}
          onClick={() => {
            if (tid) void queueRunner(c)?.send(windowId, tid, false);
          }}
        >
          Send next now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setQueue(c, windowId, (cur) => ({ ...cur, paused: !cur.paused }))}>
          {q.paused ? 'Resume' : 'Pause'}
        </Button>
        <label className="ad-queue-awake" title="While waiting for the limit to reset or sending, keep the Mac from sleeping (closing the lid still sleeps)">
          <input type="checkbox" checked={q.keepAwake} onChange={(e) => setQueue(c, windowId, (cur) => ({ ...cur, keepAwake: e.target.checked }))} />
          Keep Mac awake
        </label>
      </div>
      {q.sent.length > 0 ? (
        <details className="ad-queue-sent">
          <summary>Sent · {q.sent.length}</summary>
          <ol>
            {[...q.sent].reverse().map((s, i) => (
              <li key={`${s.sentAt}-${i}`}>
                <span className="ad-queue-muted">{clock(Date.parse(s.sentAt), Date.now())}</span> {s.text}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

