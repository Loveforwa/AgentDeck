// PL3 Prompt queue：什么时候发（decide）、书签写什么、队列的增删改，以及 QueueRunner 用假服务跑一遍：
// 碰到上限 → 到恢复时间 + 1 分钟、agent 空闲时发第一条 → 做完一轮发下一条 → 发完；又碰到上限就停下来等；Keep Mac awake。
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PromptQueueSettings, TerminalId, TerminalWindowData, UsageLimit, WindowComponentProps } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import {
  DEFAULT_QUEUE,
  RESUME_GRACE_MS,
  SELF_RESUME_FALLBACK_MS,
  addPrompt,
  armedFrom,
  decide,
  movePrompt,
  pasteKeys,
  queueLabel,
  selfResumes,
  takeFirst,
  trackSelfResume,
  type SelfResume,
} from '../src/plugins/queue-model.ts';
import { QueueRunner, setQueue } from '../src/plugins/queue.tsx';
import { Workbench } from '../src/react/Workbench.tsx';
import { createWindowRegistry } from '../src/registry.ts';

const TID = SAMPLE.terminals.loginClaude as TerminalId;
const T0 = Date.parse('2026-10-27T03:00:00.000Z');

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
  globalThis.DOMMatrixReadOnly ??= class {
    m22 = 1;
    constructor(_t?: string) {}
  } as unknown as typeof DOMMatrixReadOnly;
});

function Text(props: WindowComponentProps<Partial<TerminalWindowData>>) {
  return <div className="test-term">{props.window.data.terminalId}</div>;
}

function registry() {
  const r = createWindowRegistry();
  r.register<TerminalWindowData>({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    component: Text,
    create: (init) => ({ terminalId: null, agent: 'claude', cmd: 'claude', args: [], cwd: '~', sessionId: null, startCommand: null, ...init }),
  });
  return r;
}

const limit = (resetsAt: number, at = T0 - 3600_000): UsageLimit => ({
  kind: 'five_hour',
  resetsAt: new Date(resetsAt).toISOString(),
  at: new Date(at).toISOString(),
  detail: null,
});
const queue = (texts: string[], patch: Partial<PromptQueueSettings> = {}): PromptQueueSettings =>
  texts.reduce((q, t) => addPrompt(q, t), { ...DEFAULT_QUEUE, on: true, ...patch });

describe('Prompt queue · model', () => {
  it('only starts after the limit, at reset time + 1 minute, when the agent is idle', () => {
    const q = queue(['a', 'b']);
    expect(decide({ q, limit: null, status: 'idle', now: T0, inFlight: false }).kind).toBe('wait');
    const l = limit(T0 + 60_000);
    expect(decide({ q, limit: l, status: 'idle', now: T0, inFlight: false }).kind).toBe('wait');
    const due = T0 + 60_000 + RESUME_GRACE_MS;
    expect(decide({ q, limit: l, status: 'running', now: due, inFlight: false }).kind).toBe('wait');
    expect(decide({ q, limit: l, status: 'idle', now: due, inFlight: false })).toEqual({ kind: 'send', running: true });
    expect(decide({ q: { ...q, paused: true }, limit: l, status: 'idle', now: due, inFlight: false }).kind).toBe('wait');
  });

  it('while running: the next goes out each time it is idle again; a newer limit stops it', () => {
    const q = { ...queue(['b']), running: true, sent: [{ text: 'a', sentAt: new Date(T0).toISOString() }] };
    expect(decide({ q, limit: null, status: 'idle', now: T0, inFlight: false })).toEqual({ kind: 'send', running: true });
    expect(decide({ q, limit: null, status: 'idle', now: T0, inFlight: true }).kind).toBe('wait');
    // 发第一条之前就有的旧上限不算
    expect(decide({ q, limit: limit(T0 + 1, T0 - 10), status: 'idle', now: T0, inFlight: false }).kind).toBe('send');
    expect(decide({ q, limit: limit(T0 + 5 * 3600_000, T0 + 60_000), status: 'idle', now: T0 + 70_000, inFlight: false })).toEqual({ kind: 'stop-running' });
  });

  it('labels: waiting with a time, sending, paused, done', () => {
    const q = queue(['a', 'b', 'c']);
    expect(queueLabel(q, null, 'idle', 'claude', T0)).toMatchObject({ tone: 'muted', mark: 'Queue · 3' });
    const l = queueLabel(q, limit(T0 + 3600_000), 'idle', 'claude', T0);
    expect(l.tone).toBe('waiting');
    expect(l.mark).toMatch(/^Queue · 3 · sends /);
    expect(l.line).toMatch(/^5-hour limit reached · resets /);
    expect(queueLabel({ ...q, running: true }, null, 'running', 'claude', T0)).toMatchObject({ tone: 'running', mark: 'Sending · 3 left' });
    expect(queueLabel({ ...q, paused: true }, null, 'idle', 'claude', T0).mark).toBe('Queue · 3 · paused');
    expect(queueLabel({ ...q, prompts: [], sent: [{ text: 'x', sentAt: '' }] }, null, 'idle', 'claude', T0).mark).toBe('✓ Queue done');
    expect(queueLabel(q, { ...limit(T0), resetsAt: null }, 'idle', 'claude', T0).mark).toBe('Queue · 3 · reset time unknown');
  });

  it('reorders, takes the first into Sent, and wraps text as a bracketed paste', () => {
    const q = queue(['a', 'b', 'c']);
    const moved = movePrompt(q, q.prompts[2]!.id, -1);
    expect(moved.prompts.map((p) => p.text)).toEqual(['a', 'c', 'b']);
    const { q: after, prompt } = takeFirst(q, 'now', true);
    expect(prompt?.text).toBe('a');
    expect(after.prompts.map((p) => p.text)).toEqual(['b', 'c']);
    expect(after.sent).toEqual([{ text: 'a', sentAt: 'now' }]);
    expect(after.running).toBe(true);
    expect(takeFirst(queue(['z']), 'now', true).q.running).toBe(false);
    expect(pasteKeys('one\ntwo')).toBe('\u001b[200~one\ntwo\u001b[201~');
  });
});

describe('Prompt queue · armed and claude resuming on its own (IS-113)', () => {
  const RESET = T0 + 30 * 60_000;
  const MIN = 60_000;
  const armedQ = (patch: Partial<PromptQueueSettings> = {}) => queue(['first', 'second'], { armed: { resetsAt: RESET, at: T0 - 3600_000 }, ...patch });

  it('remembers the limit (armed): newer limits replace it, ones from before the last send do not', () => {
    const l = limit(RESET);
    const q = queue(['a']);
    expect(armedFrom(q, l)).toEqual({ resetsAt: RESET, at: Date.parse(l.at!) });
    // limit 被成功的请求清掉：记下的还在
    const armed = { ...q, armed: armedFrom(q, l) };
    expect(armedFrom(armed, null)).toBe(armed.armed);
    // 比上一条发出去的早的不算
    expect(armedFrom({ ...q, sent: [{ text: 'x', sentAt: new Date(T0).toISOString() }] }, l)).toBeNull();
    // 没写恢复时间的不记
    expect(armedFrom(q, { ...l, resetsAt: null })).toBeNull();
    // 新碰到的换掉旧的
    const later = limit(RESET + 5 * 3600_000, T0 + MIN);
    expect(armedFrom(armed, later)).toEqual({ resetsAt: RESET + 5 * 3600_000, at: T0 + MIN });
    // 发完第一条才清
    expect(takeFirst(armed, new Date(T0).toISOString(), true).q.armed).toBeNull();
  });

  it('limit becomes null but armed stays, and the prompt is sent at reset + 1 minute (agents that do not resume themselves)', () => {
    const q = armedQ();
    expect(decide({ q, limit: null, status: 'idle', now: RESET, inFlight: false }).kind).toBe('wait');
    expect(decide({ q, limit: null, status: 'idle', now: RESET + RESUME_GRACE_MS, inFlight: false })).toEqual({ kind: 'send', running: true });
    // 原来的写法（看当下的 limit）在这里一直不发
    expect(decide({ q: { ...q, armed: null }, limit: null, status: 'idle', now: RESET + RESUME_GRACE_MS, inFlight: false }).kind).toBe('wait');
  });

  it('claude ≥ 2.1.234 only', () => {
    expect(selfResumes('claude', '2.1.291 (Claude Code)')).toBe(true);
    expect(selfResumes('claude', '2.1.234')).toBe(true);
    expect(selfResumes('claude', '2.1.233')).toBe(false);
    expect(selfResumes('claude', '2.0.999')).toBe(false);
    expect(selfResumes('claude', null)).toBe(true);
    expect(selfResumes('codex', '0.164.0')).toBe(false);
  });

  /** 按时间顺序喂状态，返回每一步之后的 decide 结果。 */
  function run(q: PromptQueueSettings, steps: { now: number; status: 'idle' | 'running'; limit?: UsageLimit | null }[], startTick: number | null) {
    let sr: SelfResume | null = null;
    let tick = startTick;
    return steps.map((s) => {
      sr = trackSelfResume(sr, q.armed ?? null, s.status, s.now, tick);
      tick = s.now;
      const l = s.limit === undefined ? limit(RESET) : s.limit;
      return { d: decide({ q, limit: l, status: s.status, now: s.now, inFlight: false, selfResume: sr }).kind, sr: sr!, label: queueLabel(q, l, s.status, 'claude', s.now, { selfResumes: true, selfResume: sr }) };
    });
  }

  it('claude resumes on its own: wait for its resumed round (running → idle), then send', () => {
    const q = armedQ();
    const steps = [
      { now: RESET - 10_000, status: 'idle' as const },
      { now: RESET + 5_000, status: 'idle' as const },
      { now: RESET + 10_000, status: 'running' as const },
      // 续跑那次请求成功：limit 被清掉
      { now: RESET + 2 * MIN, status: 'running' as const, limit: null },
      { now: RESET + 4 * MIN, status: 'idle' as const, limit: null },
    ];
    const r = run(q, steps, RESET - 15_000);
    expect(r.map((x) => x.d)).toEqual(['wait', 'wait', 'wait', 'wait', 'send']);
    expect(r[0]!.label.mark).toMatch(/^Queue · 2 · claude resumes \d/);
    expect(r[0]!.label.tone).toBe('muted');
    expect(r[2]!.label).toMatchObject({ tone: 'running', mark: 'Queue · 2 · claude resuming' });
    // 已经续完、limit 清掉以后 claude 空闲：也发（AgentDeck 没看到它跑，例如应用当时关着）
    expect(decide({ q, limit: null, status: 'idle', now: RESET + 10 * MIN, inFlight: false, selfResume: { resetsAt: RESET, started: false, watchedFrom: RESET + 10 * MIN, stale: true } }).kind).toBe('send');
  });

  it('claude does not resume (setting off): still idle 3 minutes after reset → send by the old rule', () => {
    const q = armedQ();
    const r = run(
      q,
      [
        { now: RESET - 5_000, status: 'idle' },
        { now: RESET + 1_000, status: 'idle' },
        { now: RESET + RESUME_GRACE_MS + 1_000, status: 'idle' },
        { now: RESET + SELF_RESUME_FALLBACK_MS - 1_000, status: 'idle' },
        { now: RESET + SELF_RESUME_FALLBACK_MS, status: 'idle' },
      ],
      RESET - 10_000,
    );
    expect(r.map((x) => x.d)).toEqual(['wait', 'wait', 'wait', 'wait', 'send']);
    expect(r[1]!.sr.watchedFrom).toBe(RESET);
  });

  it('stale: the reset passed while nobody watched (Mac asleep) → never paste; send after claude’s own round', () => {
    const q = armedQ();
    const r = run(
      q,
      [
        { now: RESET - 60_000, status: 'idle' },
        // 电脑睡到恢复后 40 分钟
        { now: RESET + 40 * MIN, status: 'idle' },
        { now: RESET + 50 * MIN, status: 'idle' },
        // 你按了回车（或 PL4 替你按），claude 接着做
        { now: RESET + 51 * MIN, status: 'running' },
        { now: RESET + 55 * MIN, status: 'idle', limit: null },
      ],
      RESET - 65_000,
    );
    expect(r[1]!.sr.stale).toBe(true);
    expect(r.map((x) => x.d)).toEqual(['wait', 'wait', 'wait', 'wait', 'send']);
    expect(r[2]!.label).toMatchObject({ tone: 'waiting', mark: 'Queue · 2 · claude waits for Enter' });
    // 醒来时离恢复还不到 30 分钟：不算 stale，从醒来算 3 分钟
    const wake = [10, 11, 12, 13].map((m) => ({ now: RESET + m * MIN, status: 'idle' as const }));
    const short = run(q, [{ now: RESET - 60_000, status: 'idle' }, ...wake], RESET - 65_000);
    expect(short.map((x) => [x.d, x.sr.stale])).toEqual([
      ['wait', false],
      ['wait', false],
      ['wait', false],
      ['wait', false],
      ['send', false],
    ]);
  });
});

describe('Prompt queue · runner', () => {
  let api: FakeApi;
  let c: BoardController;
  let runner: QueueRunner;
  let now = T0;

  async function boot() {
    api = createFakeApi();
    c = new BoardController({ api, registry: registry(), homeDir: SAMPLE.home });
    c.setPane({ w: 1600, h: 1000 });
    await c.start();
    runner = new QueueRunner(c, () => now);
  }

  afterEach(() => {
    runner?.stop();
    c?.dispose();
    api?.dispose();
    vi.useRealTimers();
  });

  const win = () => c.state.windows.find((w) => (w.data as Partial<TerminalWindowData>).terminalId === TID)!;
  const q = () => (win().data as TerminalWindowData).queue!;

  it('sends the queue one by one after the limit resets, then stops; keeps the Mac awake while waiting', async () => {
    await boot();
    const sendKeys = vi.spyOn(api.terminals, 'sendKeys');
    now = T0;
    api.fakes.usage.set(TID, { limit: limit(T0 + 30 * 60_000) });
    api.fakes.status.set(TID, 'idle');
    setQueue(c, win().id, queue(['Add tests', 'Update docs']));
    runner.start();
    await waitFor(() => expect(api.fakes.usage.watching.has(TID)).toBe(true));
    await waitFor(() => expect(api.fakes.app.keepAwake).toBe(true));
    expect(sendKeys).not.toHaveBeenCalled();

    // 到了恢复时间 + 1 分钟，agent 空闲：发第一条
    now = T0 + 31 * 60_000 + 1;
    act(() => runner.reconcile());
    await waitFor(() => expect(sendKeys).toHaveBeenCalledWith(TID, ['Enter']));
    expect(sendKeys).toHaveBeenNthCalledWith(1, TID, [pasteKeys('Add tests')]);
    expect(q().prompts.map((p) => p.text)).toEqual(['Update docs']);
    expect(q().running).toBe(true);

    // 还没开始干活：不发下一条；干完一轮回到空闲：发下一条
    act(() => runner.reconcile());
    expect(sendKeys).toHaveBeenCalledTimes(2);
    act(() => api.fakes.status.set(TID, 'running'));
    act(() => api.fakes.status.set(TID, 'idle'));
    await waitFor(() => expect(sendKeys).toHaveBeenCalledTimes(4));
    expect(sendKeys).toHaveBeenNthCalledWith(3, TID, [pasteKeys('Update docs')]);
    expect(q().prompts).toEqual([]);
    expect(q().running).toBe(false);
    expect(q().sent.map((s) => s.text)).toEqual(['Add tests', 'Update docs']);
    await waitFor(() => expect(api.fakes.app.keepAwake).toBe(false));
  });

  it('a new limit while sending stops it until the next reset', async () => {
    await boot();
    const sendKeys = vi.spyOn(api.terminals, 'sendKeys');
    now = T0;
    api.fakes.status.set(TID, 'idle');
    setQueue(c, win().id, { ...queue(['b', 'c']), running: true, sent: [{ text: 'a', sentAt: new Date(T0 - 1000).toISOString() }] });
    api.fakes.usage.set(TID, { limit: limit(T0 + 5 * 3600_000, T0) });
    runner.start();
    await waitFor(() => expect(q().running).toBe(false));
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('claude ≥ 2.1.234: armed survives the limit being cleared by claude’s own resume; the first prompt goes out after that round (IS-113)', async () => {
    await boot();
    c.store.setState((s) => ({ agents: s.agents.map((a) => (a.id === 'claude' ? { ...a, version: '2.1.291' } : a)) }));
    const sendKeys = vi.spyOn(api.terminals, 'sendKeys');
    const reset = T0 + 30 * 60_000;
    now = T0;
    api.fakes.usage.set(TID, { limit: limit(reset) });
    api.fakes.status.set(TID, 'idle');
    setQueue(c, win().id, queue(['first', 'second']));
    runner.start();
    await waitFor(() => expect(q().armed).toEqual({ resetsAt: reset, at: Date.parse(limit(reset).at!) }));
    // 按 5 秒一次走到恢复后：claude 自己续，AgentDeck 不发
    for (now = T0; now <= reset + 10_000; now += 5_000) act(() => runner.reconcile());
    act(() => api.fakes.status.set(TID, 'running'));
    // 续跑那次请求成功：limit 被清掉，armed 还在
    act(() => api.fakes.usage.set(TID, { limit: null }));
    now = reset + 2 * 60_000;
    act(() => runner.reconcile());
    expect(q().armed).not.toBeNull();
    expect(sendKeys).not.toHaveBeenCalled();
    now += 5_000;
    act(() => api.fakes.status.set(TID, 'idle'));
    await waitFor(() => expect(sendKeys).toHaveBeenCalledWith(TID, ['Enter']));
    expect(sendKeys).toHaveBeenNthCalledWith(1, TID, [pasteKeys('first')]);
    expect(q().armed).toBeNull();
    expect(q().running).toBe(true);
  });

  it('Send next now sends one without starting the run', async () => {
    await boot();
    const sendKeys = vi.spyOn(api.terminals, 'sendKeys');
    api.fakes.status.set(TID, 'idle');
    setQueue(c, win().id, queue(['x', 'y']));
    runner.start();
    await act(async () => {
      await runner.send(win().id, TID, false);
    });
    expect(sendKeys).toHaveBeenCalledWith(TID, [pasteKeys('x')]);
    expect(q().prompts.map((p) => p.text)).toEqual(['y']);
    expect(q().running).toBe(false);
  });
});

describe('Prompt queue · bookmark', () => {
  it('shows the queue state under the terminal and opens the card', async () => {
    const api = createFakeApi();
    const c = new BoardController({ api, registry: registry() });
    render(<Workbench api={api} controller={c} />);
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => api.fakes.status.set(TID, 'idle'));
    act(() => setQueue(c, c.state.windows.find((w) => (w.data as Partial<TerminalWindowData>).terminalId === TID)!.id, queue(['Add tests', 'Update docs'])));
    const mark = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>('.ad-queue-mark');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(mark.textContent).toBe('Queue · 2');
    act(() => mark.click());
    await waitFor(() => expect(document.querySelector('.ad-queue-card')).not.toBeNull());
    expect([...document.querySelectorAll('.ad-queue-text')].map((e) => e.textContent)).toEqual(['Add tests', 'Update docs']);
    expect(document.querySelector('.ad-queue-card')!.textContent).toContain('Keep Mac awake');
    c.dispose();
    api.dispose();
  });
});
