// PL6 Auto-resume：开关（终端 → 框 → 白板）、书签的各种样子、卡片里改这一次续跑的话、Resume now、Don’t resume。
// 对着 createFakeApi()（FakeLimitService 发 limits.changed）。PL3 Prompt queue 退役：老白板里的 queue 读得进来、不起作用。
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { MenuEntry, MenuItem } from '@agentdeck/ui-kit';
import type { AccountLimit, LimitedTerminal, TerminalWindowData, WindowComponentProps, WindowId } from '@agentdeck/contracts';
import { createFakeApi, FAKE_RESUME_PROMPT, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { PLUGINS, pluginMenuSection } from '../src/plugins/index.ts';
import { clock, resumeActions, resumeLabel, toggledAutoResume, windowAutoResume, type LimitView } from '../src/plugins/auto-resume-model.ts';
import { menuItems } from '../src/react/BoardMenu.tsx';
import { Workbench } from '../src/react/Workbench.tsx';
import { createWindowRegistry } from '../src/registry.ts';
import { PLUGIN_MARK_HEIGHT } from '../src/plugins/types.ts';
import css from '../src/canvas.css?raw';

const T = SAMPLE.terminals;
const W = SAMPLE.workspaces;
const CLAUDE = 'win-login-claude' as WindowId;
const CODEX = 'win-login-codex' as WindowId;
const SHELL = 'win-shop-shell' as WindowId;

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

function Text(props: WindowComponentProps) {
  return <div data-testid={`content ${props.window.id}`} />;
}

function registry() {
  const r = createWindowRegistry();
  r.register({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    component: Text,
    create: (init: object) => ({ terminalId: null, ...init }),
  });
  return r;
}

async function started(api: FakeApi = createFakeApi()) {
  const c = new BoardController({ api, registry: registry() });
  await c.start();
  return { api, c };
}

function item(entries: MenuEntry[], label: string): MenuItem {
  const found = entries.find((e): e is MenuItem => (e.type === undefined || e.type === 'item') && e.label === label);
  if (!found) throw new Error(`no menu item ${label}`);
  return found;
}

const data = (c: BoardController, id: WindowId) => c.windowById(id)!.data as TerminalWindowData;

// ---- 纯逻辑 ----

const NOW = Date.parse('2026-10-28T15:00:00');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

function view(t: Partial<LimitedTerminal> = {}, a: Partial<AccountLimit> = {}): LimitView {
  const terminal: LimitedTerminal = { terminalId: T.loginCodex, state: 'interrupted', owner: 'auto-resume', resumeAt: at(31), lostSubagents: 0, autoResume: true, ...t };
  return {
    terminal,
    account: {
      key: 'codex:/Users/you/.codex:all',
      agent: 'codex',
      configDir: '/Users/you/.codex',
      scope: 'all',
      kind: 'five_hour',
      resetsAt: at(30),
      at: at(-60),
      detail: null,
      terminals: [terminal],
      needsYou: null,
      ...a,
    },
  };
}

describe('Auto-resume bookmark text (PL6)', () => {
  const label = (v: LimitView, agent = 'codex', now = NOW) => {
    const l = resumeLabel(v, agent, now);
    return [l.mark, l.tone];
  };

  it('covers every state with the status colours only', () => {
    const t = clock(NOW + 31 * 60_000, NOW);
    const r = clock(NOW + 30 * 60_000, NOW);
    expect(t).toBe('3:31pm');
    expect(label(view())).toEqual([`Paused · resumes ${t}`, 'waiting']);
    expect(label(view({ state: 'resuming' }))).toEqual(['Resuming', 'running']);
    expect(label(view({ owner: 'agent', resumeAt: null, selfResume: 'waiting' }, { agent: 'claude' }), 'claude')).toEqual([`claude resumes ${r}`, 'muted']);
    expect(label(view({ owner: 'agent', selfResume: 'fired', state: 'resuming' }, { agent: 'claude' }), 'claude')).toEqual(['claude resuming', 'running']);
    expect(label(view({ owner: 'agent', selfResume: 'stale' }, { agent: 'claude', needsYou: 'stale' }), 'claude')).toEqual(['claude waits for Enter', 'waiting']);
    expect(label(view({ state: 'gave-up' }))).toEqual(['Hit the limit again', 'error']);
    expect(label(view({ resumeAt: null }, { resetsAt: null, needsYou: 'reset-unknown' }), 'kimi')).toEqual(['Reset time unknown', 'waiting']);
    expect(label(view({}, { needsYou: 'slept' }))).toEqual(['Waiting for you', 'waiting']);
    expect(label(view({ state: 'took-over' }))).toEqual(['Not resumed · you took over', 'muted']);
    expect(label(view({ state: 'skipped' }))).toEqual(['Skipped', 'muted']);
    expect(label(view(), 'omp')).toEqual(['handled by omp', 'muted']);
    expect(label(view({ autoResume: false, resumeAt: null }))).toEqual([`Limit · resets ${r}`, 'muted']);
    // 悬停 = 卡片的那一句
    expect(resumeLabel(view(), 'codex', NOW).line).toContain(`Resumes at ${t}`);
    expect(resumeLabel(view({ owner: 'agent', messageDelivered: true }), 'claude', NOW).line).toContain('send your message instead');
  });

  it('Resume now waits for the reset (or works at once when nobody knows it); Don’t resume is per terminal and not for claude’s own resume', () => {
    expect(resumeActions(view(), 'codex', NOW, true)).toMatchObject({ resumeNow: false, skip: true, editable: true, showMessage: true });
    expect(resumeActions(view(), 'codex', NOW, true).resumeNowWhy).toBe('Available after the limit resets at 3:30pm');
    expect(resumeActions(view(), 'codex', NOW + 30 * 60_000, true).resumeNow).toBe(true);
    expect(resumeActions(view({}, { resetsAt: null }), 'kimi', NOW, true).resumeNow).toBe(true);
    expect(resumeActions(view({ owner: 'agent' }), 'claude', NOW, true)).toMatchObject({ skip: false, editable: true });
    expect(resumeActions(view({ owner: 'agent', messageDelivered: true }), 'claude', NOW, true).editable).toBe(false);
    expect(resumeActions(view({ state: 'resuming' }), 'codex', NOW, true)).toMatchObject({ resumeNow: false, skip: false, showMessage: false });
    expect(resumeActions(view(), 'omp', NOW, true)).toMatchObject({ resumeNow: false, showMessage: false });
    expect(resumeActions(view(), 'codex', NOW, false).editable).toBe(false);
  });
});

// ---- 开关 ----

describe('Auto-resume switch: terminal → frame → board, off by default (PL6)', () => {
  it('lists it for agent terminals (pi, kimi, omp too), frames and the blank board; not for shell', async () => {
    const { c } = await started();
    const labels = (t: Parameters<typeof pluginMenuSection>[1]) => pluginMenuSection(c, t, PLUGINS).map((e) => (e.type === 'separator' ? '-' : e.label));
    expect(labels({ kind: 'window', windowId: CLAUDE })).toContain('Auto-resume');
    expect(labels({ kind: 'window', windowId: SHELL })).not.toContain('Auto-resume');
    expect(labels({ kind: 'frame', workspaceId: W.agentdeckLogin })).toContain('Auto-resume');
    expect(labels({ kind: 'board' })).toEqual(['PLUGINS', 'Auto-resume']);
    for (const agent of ['pi', 'kimi', 'omp']) {
      c.updateData(CODEX, { agent });
      const entry = item(pluginMenuSection(c, { kind: 'window', windowId: CODEX }, PLUGINS), 'Auto-resume');
      expect(entry.disabled).toBe(false);
    }
    c.dispose();
  });

  it('terminal setting wins; switching a frame or the board clears the settings below it; saved with the board', async () => {
    const { api, c } = await started();
    const on = (id: WindowId) => windowAutoResume(c.state, c.windowById(id));
    expect(on(CLAUDE)).toBe(false);
    const pane = menuItems(c, { screen: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, target: { kind: 'pane' } }, { terminal: true, browser: true });
    act(() => item(pane, 'Auto-resume').onSelect?.());
    expect(c.state.autoResume).toBe(true);
    expect(on(CLAUDE)).toBe(true);
    expect(on(SHELL)).toBe(false); // shell 从来不算
    // 终端单独关
    act(() => item(pluginMenuSection(c, { kind: 'window', windowId: CLAUDE }, PLUGINS), 'Auto-resume').onSelect?.());
    expect(data(c, CLAUDE).autoResume).toBe(false);
    expect(on(CLAUDE)).toBe(false);
    expect(on(CODEX)).toBe(true);
    // 框上关：框里的都关，单独的设置清掉
    act(() => item(pluginMenuSection(c, { kind: 'frame', workspaceId: W.agentdeckLogin }, PLUGINS), 'Auto-resume').onSelect?.());
    expect(c.state.frames.find((f) => f.workspaceId === W.agentdeckLogin)?.autoResume).toBe(false);
    expect(data(c, CLAUDE).autoResume).toBeNull();
    expect([on(CLAUDE), on(CODEX)]).toEqual([false, false]);
    // 框上再开：框里的都开
    act(() => item(pluginMenuSection(c, { kind: 'frame', workspaceId: W.agentdeckLogin }, PLUGINS), 'Auto-resume').onSelect?.());
    expect([on(CLAUDE), on(CODEX)]).toEqual([true, true]);
    // 白板上关：全部回到白板
    const next = toggledAutoResume(c.state, { kind: 'board' });
    expect(next.autoResume).toBe(false);
    expect(next.frames.every((f) => f.autoResume === null || f.autoResume === undefined)).toBe(true);
    // 随白板保存
    expect(c.snapshotBoard().autoResume).toBe(true);
    const save = vi.spyOn(api.board, 'save');
    await c.flush();
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls.at(-1)?.[0].autoResume).toBe(true);
    expect(save.mock.calls.at(-1)?.[0].frames.find((f) => f.workspaceId === W.agentdeckLogin)?.autoResume).toBe(true);
    c.dispose();
  });

  it('a saved board that still has a PL3 queue loads fine and the queue does nothing', async () => {
    const api = createFakeApi();
    const board = await api.board.load();
    const legacy = {
      ...board,
      windows: board.windows.map((w) =>
        w.id === CODEX ? { ...w, data: { ...(w.data as object), queue: { on: true, prompts: [{ id: 'p1', text: 'Add tests' }], sent: [], paused: false, keepAwake: true, running: true } } } : w,
      ),
    };
    await api.board.save(legacy);
    const keepAwake = vi.spyOn(api.app, 'setKeepAwake');
    const send = vi.spyOn(api.terminals, 'sendKeys');
    const { c } = await started(api);
    render(<Workbench api={api} controller={c} />);
    await waitFor(() => expect(c.state.loaded).toBe(true));
    expect(document.querySelector('.ad-auto-resume-mark')).toBeNull();
    expect(c.markOutset(c.windowById(CODEX)!).bottom).toBe(0);
    expect(keepAwake).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    c.dispose();
  });
});

// ---- 书签和卡片 ----

describe('Auto-resume bookmark and card (PL6)', () => {
  const node = (id: WindowId) => document.querySelector<HTMLElement>(`[data-window-id="${id}"]`);
  const mark = (id: WindowId) => node(id)?.querySelector<HTMLElement>('.ad-auto-resume-mark') ?? null;
  async function setup() {
    const api = createFakeApi();
    const c = new BoardController({ api, registry: registry() });
    render(<Workbench api={api} controller={c} />);
    await waitFor(() => expect(c.state.loaded).toBe(true));
    return { api, c };
  }
  const hitCodex = (api: FakeApi, resetsAt: string | null = new Date(Date.now() + 30 * 60_000).toISOString()) =>
    act(() => {
      api.fakes.limits.hit({
        agent: 'codex',
        configDir: '/Users/you/.codex',
        resetsAt,
        terminals: [{ terminalId: T.loginCodex, autoResume: true }],
      });
    });

  it('hangs only while the terminal is in a limited account, after Auto-approve, and the frame makes room for it', async () => {
    const { api, c } = await setup();
    expect(mark(CODEX)).toBeNull();
    // 开着但没撞上：不挂
    act(() => c.store.setState((s) => toggledAutoResume(s, { kind: 'board' })));
    expect(mark(CODEX)).toBeNull();
    hitCodex(api);
    const b = await waitFor(() => mark(CODEX) ?? Promise.reject(new Error('no mark')));
    expect(b.dataset.state).toBe('paused');
    expect(b.textContent).toMatch(/^Paused · resumes \d+:\d\d[ap]m$/);
    expect(b.title).toMatch(/^Stopped by the usage limit/);
    expect(b.querySelector('.ad-auto-resume-lamp--waiting')).not.toBeNull();
    expect(c.markOutset(c.windowById(CODEX)!).bottom).toBe(PLUGIN_MARK_HEIGHT);
    expect(mark(CLAUDE)).toBeNull();
    // 续完、账号从列表里消失：收起
    const key = (await api.limits.list())[0]!.key;
    act(() => api.fakes.limits.reset(key));
    await waitFor(() => expect(mark(CODEX)?.dataset.state).toBe('resuming'));
    act(() => api.fakes.limits.finish(T.loginCodex));
    await waitFor(() => expect(mark(CODEX)).toBeNull());
    expect(api.fakes.limits.sent).toEqual([{ terminalId: T.loginCodex, text: FAKE_RESUME_PROMPT }]);
    c.dispose();
  });

  it('card: the message is prefilled; ⌘↩ saves the edit for this limit; Reset to default; Resume now waits for the reset; Don’t resume skips this terminal', async () => {
    const { api, c } = await setup();
    hitCodex(api);
    const b = await waitFor(() => mark(CODEX) ?? Promise.reject(new Error('no mark')));
    fireEvent.click(b);
    const card = await screen.findByRole('dialog', { name: 'Auto-resume' });
    const box = within(card).getByLabelText('Message') as HTMLTextAreaElement;
    expect(box.value).toBe(FAKE_RESUME_PROMPT);
    expect(within(card).getByRole('button', { name: 'Resume now' })).toHaveProperty('disabled', true);
    expect(within(card).queryByRole('button', { name: 'Reset to default' })).toBeNull();
    fireEvent.change(box, { target: { value: 'Finish the migration, then run pnpm test.' } });
    // 改着的时候 Resume now 不能点（先存或取消）
    expect(within(card).getByRole('button', { name: 'Save' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(async () => expect((await api.limits.list())[0]?.terminals[0]?.message).toBe('Finish the migration, then run pnpm test.'));
    await waitFor(() => expect(within(card).queryByRole('button', { name: 'Save' })).toBeNull());
    expect(box.value).toBe('Finish the migration, then run pnpm test.');
    fireEvent.click(within(card).getByRole('button', { name: 'Reset to default' }));
    await waitFor(async () => expect((await api.limits.list())[0]?.terminals[0]?.message).toBeNull());
    await waitFor(() => expect(box.value).toBe(FAKE_RESUME_PROMPT));
    // Don’t resume：只这个终端
    const skip = vi.spyOn(api.limits, 'skip');
    fireEvent.click(within(card).getByRole('button', { name: 'Don’t resume' }));
    await waitFor(() => expect(skip).toHaveBeenCalledWith(T.loginCodex));
    c.dispose();
  });

  it('no reset time (pi, kimi): Resume now sends the edited message right away', async () => {
    const { api, c } = await setup();
    hitCodex(api, null);
    const b = await waitFor(() => mark(CODEX) ?? Promise.reject(new Error('no mark')));
    expect(b.dataset.state).toBe('reset-unknown');
    fireEvent.click(b);
    const card = await screen.findByRole('dialog', { name: 'Auto-resume' });
    const box = within(card).getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Pick up from step 3.' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Resume now' })).toHaveProperty('disabled', false));
    fireEvent.click(within(card).getByRole('button', { name: 'Resume now' }));
    await waitFor(() => expect(api.fakes.limits.sent).toEqual([{ terminalId: T.loginCodex, text: 'Pick up from step 3.' }]));
    c.dispose();
  });

  it('claude resumes by itself: grey bookmark; an edited message is given to claude and can’t be changed after', async () => {
    const { api, c } = await setup();
    act(() => {
      api.fakes.limits.hit({
        agent: 'claude',
        configDir: '/Users/you/.claude',
        resetsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        terminals: [{ terminalId: T.loginClaude, owner: 'agent' }],
      });
    });
    const b = await waitFor(() => mark(CLAUDE) ?? Promise.reject(new Error('no mark')));
    expect(b.dataset.state).toBe('self-waiting');
    expect(b.textContent).toMatch(/^claude resumes /);
    expect(b.dataset.tone).toBe('muted');
    fireEvent.click(b);
    const card = await screen.findByRole('dialog', { name: 'Auto-resume' });
    expect(within(card).queryByRole('button', { name: 'Don’t resume' })).toBeNull();
    const box = within(card).getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Use the new API instead.' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Give to claude' }));
    await waitFor(() => expect(api.fakes.limits.sent).toEqual([{ terminalId: T.loginClaude, text: 'Use the new API instead.' }]));
    await waitFor(() => expect(box.readOnly).toBe(true));
    expect(within(card).getByText(/it sends this instead of its own continue/)).toBeTruthy();
    c.dispose();
  });

  it('the bookmark styles use tokens only', () => {
    const block = (sel: string) => {
      const m = css.replace(/\/\*[\s\S]*?\*\//g, '').match(new RegExp(`${sel.replace(/[.-]/g, (x) => `\\${x}`)}\\s*\\{([^}]*)\\}`));
      return m?.[1] ?? '';
    };
    expect(block('.ad-auto-resume-lamp--running')).toMatch(/var\(--status-running\)/);
    expect(block('.ad-auto-resume-lamp--waiting')).toMatch(/var\(--status-waiting\)/);
    expect(block('.ad-auto-resume-lamp--error')).toMatch(/var\(--status-error\)/);
    expect(block('.ad-auto-resume-mark')).toMatch(/height:\s*var\(--plugin-mark-height\)/);
    expect(css).not.toContain('.ad-queue-');
  });
});
