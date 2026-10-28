// PL3 Prompt queue：什么时候发（decide）、书签写什么、队列的增删改，以及 QueueRunner 用假服务跑一遍：
// 碰到上限 → 到恢复时间 + 1 分钟、agent 空闲时发第一条 → 做完一轮发下一条 → 发完；又碰到上限就停下来等；Keep Mac awake。
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PromptQueueSettings, TerminalId, TerminalWindowData, UsageLimit, WindowComponentProps } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { DEFAULT_QUEUE, RESUME_GRACE_MS, addPrompt, decide, movePrompt, pasteKeys, queueLabel, takeFirst } from '../src/plugins/queue-model.ts';
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
