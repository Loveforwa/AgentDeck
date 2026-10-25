// PL2 Usage：菜单开关、用量条的数字和缩写、85% 变黄、读不到数据、拖到上下边和保存、小卡片（含 codex 额度）、
// watch / unwatch 跟着条走。对着 createFakeApi() 的 FakeUsageService。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MenuEntry, MenuItem } from '@agentdeck/ui-kit';
import type { TerminalId, TerminalUsage, TerminalWindowData, WindowComponentProps, WindowId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { menuItems } from '../src/react/BoardMenu.tsx';
import { Workbench } from '../src/react/Workbench.tsx';
import { setUsage } from '../src/plugins/usage.tsx';
import { createWindowRegistry } from '../src/registry.ts';
import {
  CONTEXT_ATTENTION_PERCENT,
  AGENT_FORMATS,
  abbreviate1024,
  claudeTokens,
  codexLimitText,
  codexResetTime,
  codexTokens,
  contextDisplay,
  abbreviate,
  cacheText,
  lastRequestText,
  limitLabel,
  limitRows,
  ompTokens,
  piTokens,
  rustFixed,
  tokensText,
  usageOutset,
} from '../src/plugins/usage-model.ts';
import css from '../src/canvas.css?raw';

const T = SAMPLE.terminals;
const W = SAMPLE.workspaces;
const CLAUDE = 'win-login-claude' as WindowId;
const CODEX = 'win-login-codex' as WindowId;
const SHOP = 'win-shop-claude' as WindowId;

function declarations(selector: string): string {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2] ?? '');
  }
  return out.join('\n');
}

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

afterEach(() => cleanup());

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

const CLAUDE_USAGE: Partial<TerminalUsage> = {
  agent: 'claude',
  state: 'ok',
  reason: null,
  match: 'exact',
  model: 'claude-opus-5-5',
  total: { input: 312_000, output: 18_400, cacheRead: 1_400_000, cacheWrite: 86_000, reasoning: null },
  last: { input: 2_100, output: 640, cacheRead: 94_000, cacheWrite: 0, reasoning: null },
  requests: 37,
  context: { tokens: 96_000, window: 200_000, percent: 48, windowSource: 'model-table' },
  updatedAt: '2026-10-25T10:00:00.000Z',
};

const CODEX_USAGE: Partial<TerminalUsage> = {
  agent: 'codex',
  state: 'ok',
  reason: null,
  match: 'exact',
  model: 'gpt-5.5-codex',
  total: { input: 1_230_000, output: 64_200, cacheRead: 5_800_000, cacheWrite: null, reasoning: 41_000 },
  last: { input: 8_400, output: 1_200, cacheRead: 228_000, cacheWrite: null, reasoning: 800 },
  requests: 112,
  context: { tokens: 248_000, window: 272_000, percent: 91, windowSource: 'agent' },
  rateLimits: {
    primary: { usedPercent: 23, windowMinutes: 300, resetsAt: null },
    secondary: { usedPercent: 41, windowMinutes: 10080, resetsAt: null },
  },
  updatedAt: '2026-10-25T10:00:00.000Z',
};

function seeded(): FakeApi {
  const api = createFakeApi();
  api.fakes.usage.set(T.loginClaude, CLAUDE_USAGE);
  api.fakes.usage.set(T.loginCodex, CODEX_USAGE);
  return api;
}

async function setup(api: FakeApi = seeded()) {
  const c = new BoardController({ api, registry: registry() });
  render(<Workbench api={api} controller={c} />);
  await waitFor(() => expect(c.state.loaded).toBe(true));
  return { api, c };
}

function windowMenu(c: BoardController, windowId: WindowId): MenuEntry[] {
  return menuItems(c, { screen: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, target: { kind: 'window', windowId } }, { terminal: true, browser: true });
}

function labelsOf(entries: MenuEntry[]): string[] {
  return entries.map((e) => (e.type === 'separator' ? '-' : e.label));
}

function item(entries: MenuEntry[], label: string): MenuItem {
  const found = entries.find((e): e is MenuItem => (e.type === undefined || e.type === 'item') && e.label === label);
  if (!found) throw new Error(`no menu item ${label}`);
  return found;
}

const data = (c: BoardController, id: WindowId) => c.windowById(id)!.data as TerminalWindowData;
const node = (id: WindowId) => document.querySelector<HTMLElement>(`[data-window-id="${id}"]`);
const strip = (id: WindowId) => node(id)?.querySelector<HTMLElement>('.ad-usage-strip') ?? null;

async function turnOn(c: BoardController, id: WindowId): Promise<HTMLElement> {
  act(() => item(windowMenu(c, id), 'Usage').onSelect?.());
  return waitFor(() => {
    const el = strip(id);
    if (!el) throw new Error('no strip');
    return el;
  });
}

/** 白板坐标 → 屏幕坐标（jsdom 里白板的原点在 0, 0）。 */
function toScreen(c: BoardController, p: { x: number; y: number }) {
  const v = c.state.viewport;
  return { clientX: p.x * v.zoom + v.x, clientY: p.y * v.zoom + v.y };
}

describe('PL2 Usage in the PLUGINS menu', () => {
  it('a terminal’s menu has Usage after Auto-approve; a click turns it on (top by default) and saves it on the window', async () => {
    const { c } = await setup();
    const labels = labelsOf(windowMenu(c, CLAUDE));
    const at = labels.indexOf('PLUGINS');
    expect(labels.slice(at, at + 3)).toEqual(['PLUGINS', 'Auto-approve', 'Usage']);
    expect(item(windowMenu(c, CLAUDE), 'Usage').checked).toBe(false);
    expect(data(c, CLAUDE).usage ?? null).toBeNull();
    await turnOn(c, CLAUDE);
    expect(item(windowMenu(c, CLAUDE), 'Usage').checked).toBe(true);
    expect(data(c, CLAUDE).usage).toEqual({ on: true, position: 'top' });
    act(() => item(windowMenu(c, CLAUDE), 'Usage').onSelect?.());
    await waitFor(() => expect(strip(CLAUDE)).toBeNull());
    expect(data(c, CLAUDE).usage).toEqual({ on: false, position: 'top' });
    expect(item(windowMenu(c, CLAUDE), 'Usage').checked).toBe(false);
    c.dispose();
  });

  it('shell terminals are greyed out (“Not supported for shell”); frames and browsers have no Usage', async () => {
    const { c } = await setup();
    const shell = item(windowMenu(c, 'win-dev-server' as WindowId), 'Usage');
    expect(shell.disabled).toBe(true);
    expect(shell.hint).toBe('Not supported for shell');
    expect(labelsOf(windowMenu(c, 'win-browser' as WindowId))).not.toContain('Usage');
    const frame = menuItems(c, { screen: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, target: { kind: 'frame-title', workspaceId: W.agentdeckLogin } }, { terminal: true, browser: true });
    expect(labelsOf(frame)).not.toContain('Usage');
    // 所有 agent 都支持
    for (const agent of ['claude', 'codex', 'pi', 'omp', 'kimi']) {
      const id = c.addWindow<Partial<TerminalWindowData>>({
        type: 'terminal',
        workspaceId: W.agentdeckLogin,
        rect: { x: 1300, y: 600, w: 400, h: 300 },
        data: { terminalId: `term-${agent}` as TerminalId, agent, cmd: agent, args: [], cwd: '/tmp' },
      });
      expect(item(windowMenu(c, id), 'Usage').disabled).toBeFalsy();
    }
    c.dispose();
  });
});

describe('PL2 the strip', () => {
  it('sits above the terminal, as wide as it, 6px away, outside the window frame; numbers are abbreviated, labels muted', async () => {
    const { c } = await setup();
    const el = await turnOn(c, CLAUDE);
    await waitFor(() => expect(el.dataset.state).toBe('ok'));
    expect(el.dataset.position).toBe('top');
    expect(el.closest('.ad-window')).toBeNull();
    expect(el.parentElement?.classList.contains('ad-window-node')).toBe(true);
    const field = (f: string) => el.querySelector<HTMLElement>(`[data-field="${f}"]`)!.textContent;
    expect(field('in')).toBe('Input 312k');
    expect(field('out')).toBe('Output 18.4k');
    // claude 自己的写法：小写 k / m（formatTokens）
    expect(field('cache')).toBe('Cache 1.4m');
    expect(field('ctx')).toBe('Context 96k / 200k48%');
    expect(el.querySelector<HTMLElement>('.ad-usage-meter > i')!.style.width).toBe('48%');
    expect(el.querySelector('.ad-usage-grip')).not.toBeNull();
    // 悬停：准确数和模型名
    const title = el.querySelector<HTMLElement>('.ad-usage-body')!.title;
    expect(title).toContain('Input 312,000 · output 18,400');
    expect(title).toContain('Cache read 1,400,000 · cache write 86,000');
    expect(title).toContain('Context 96,000 of 200,000 (48%)');
    expect(title).toContain('claude-opus-5-5');
    expect(title).not.toContain('inferred');
    // 样子：tokens，24px 圆角条，左右贴齐窗口，上边隔 6px
    const d = declarations('.ad-usage-strip');
    expect(d).toMatch(/position:\s*absolute/);
    expect(d).toMatch(/left:\s*0/);
    expect(d).toMatch(/right:\s*0/);
    expect(d).toMatch(/height:\s*var\(--plugin-strip-height\)/);
    expect(d).toMatch(/border-radius:\s*calc\(var\(--plugin-strip-height\) \/ 2\)/);
    expect(d).toMatch(/background:\s*var\(--surface\)/);
    expect(d).toMatch(/box-shadow:\s*var\(--shadow-mark\)/);
    expect(declarations(".ad-usage-strip[data-position='top']")).toMatch(/bottom:\s*calc\(100% \+ var\(--plugin-strip-gap\)\)/);
    expect(declarations(".ad-usage-strip[data-position='bottom']")).toMatch(/top:\s*calc\(100% \+ var\(--plugin-strip-gap\)\)/);
    expect(declarations('.ad-usage-k')).toMatch(/color:\s*var\(--muted\)/);
    c.dispose();
  });

  it('updates on usage.changed while it is shown', async () => {
    const { api, c } = await setup();
    const el = await turnOn(c, CLAUDE);
    await waitFor(() => expect(el.dataset.state).toBe('ok'));
    act(() => {
      api.fakes.usage.set(T.loginClaude, {
        total: { input: 1_250_000, output: 999_960, cacheRead: 2_000_000, cacheWrite: 86_000, reasoning: null },
        context: { tokens: 120_000, window: 200_000, percent: 60, windowSource: 'model-table' },
      });
    });
    await waitFor(() => expect(el.querySelector('[data-field="in"]')!.textContent).toBe('Input 1.3m'));
    expect(el.querySelector('[data-field="out"]')!.textContent).toBe('Output 1m');
    expect(el.querySelector('[data-field="ctx"]')!.textContent).toBe('Context 120k / 200k60%');
    c.dispose();
  });

  it(`turns the context number and bar to the attention color at ${CONTEXT_ATTENTION_PERCENT}%`, async () => {
    const { api, c } = await setup();
    const el = await turnOn(c, CODEX);
    await waitFor(() => expect(el.dataset.state).toBe('ok'));
    const ctx = el.querySelector<HTMLElement>('[data-field="ctx"]')!;
    expect(ctx.dataset.attention).toBe('true');
    expect(el.className).toContain('ad-usage-strip--attention');
    // codex 不报缓存写：只写读
    expect(el.querySelector('[data-field="cache"]')!.textContent).toBe('Cache 5.8M');
    // codex 的写法：大写 K、百分比写还剩多少（248000 / 272000 → 9% left，进度条按用了的 91%）
    expect(ctx.textContent).toBe('Context 248K / 272K9% left');
    expect(el.querySelector<HTMLElement>('.ad-usage-meter > i')!.style.width).toBe('91%');
    expect(declarations('.ad-usage-ctx[data-attention]')).toMatch(/color:\s*var\(--attention\)/);
    expect(declarations('.ad-usage-ctx[data-attention] .ad-usage-meter > i')).toMatch(/background:\s*var\(--attention\)/);
    act(() => void api.fakes.usage.set(T.loginCodex, { context: { tokens: 228_000, window: 272_000, percent: 84, windowSource: 'agent' } }));
    await waitFor(() => expect(ctx.dataset.attention).toBeUndefined());
    // codex 照它自己的算法先扣 12000 的基线：(233500 - 12000) / (272000 - 12000) ≈ 85%
    act(() => void api.fakes.usage.set(T.loginCodex, { context: { tokens: 233_500, window: 272_000, percent: 85, windowSource: 'agent' } }));
    await waitFor(() => expect(ctx.dataset.attention).toBe('true'));
    c.dispose();
  });

  it('shows “No usage data” (muted) when the service has none, with the reason on hover; inferred sessions say so', async () => {
    const { api, c } = await setup();
    const el = await turnOn(c, SHOP);
    await waitFor(() => expect(el.dataset.state).toBe('no-data'));
    await waitFor(() => expect(el.textContent).toBe('No usage data'));
    expect(el.querySelector<HTMLElement>('.ad-usage-body')!.title).toBe('No usage data: No session file yet');
    expect(declarations('.ad-usage-empty')).toMatch(/color:\s*var\(--muted\)/);
    expect(el.querySelector('[data-field]')).toBeNull();
    // 推断出来的会话：悬停写明
    act(() => void api.fakes.usage.set(T.shopClaude, { ...CLAUDE_USAGE, match: 'inferred' }));
    await waitFor(() => expect(el.dataset.state).toBe('ok'));
    expect(el.querySelector<HTMLElement>('.ad-usage-body')!.title).toContain('Session inferred from the folder and start time');
    // unsupported 也是 No usage data
    act(() => void api.fakes.usage.set(T.shopClaude, { state: 'unsupported', reason: 'Not an agent', match: null }));
    await waitFor(() => expect(el.dataset.state).toBe('no-data'));
    expect(el.querySelector<HTMLElement>('.ad-usage-body')!.title).toBe('No usage data: Not an agent');
    c.dispose();
  });

  it('a terminal without a terminalId (not restored yet) shows No usage data and is not watched', async () => {
    const { api, c } = await setup();
    const id = c.addWindow<Partial<TerminalWindowData>>({
      type: 'terminal',
      workspaceId: W.agentdeckLogin,
      rect: { x: 1300, y: 600, w: 400, h: 300 },
      data: { terminalId: null, agent: 'claude', cmd: 'claude', args: [], cwd: '/tmp' },
    });
    const el = await turnOn(c, id);
    expect(el.textContent).toBe('No usage data');
    expect(el.querySelector<HTMLElement>('.ad-usage-body')!.title).toBe('No usage data: The terminal is not running');
    expect(api.fakes.usage.watching.size).toBe(0);
    c.dispose();
  });
});

describe('PL2 docking to the top or bottom edge', () => {
  it('dragging the grip shows a blue drop line on the edge it will dock to; release docks there; it persists across a restart', async () => {
    const { api, c } = await setup();
    const el = await turnOn(c, CLAUDE);
    const grip = el.querySelector<HTMLElement>('.ad-usage-grip')!;
    const r = c.windowById(CLAUDE)!.rect;
    const start = toScreen(c, { x: r.x + 10, y: r.y - 18 });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, ...start });
    expect(el.className).toContain('ad-usage-strip--dragging');
    const drop = () => node(CLAUDE)!.querySelector<HTMLElement>('.ad-usage-drop');
    expect(drop()?.dataset.position).toBe('top');
    // 过了中线：落点线换到下边
    fireEvent.pointerMove(grip, { pointerId: 1, ...toScreen(c, { x: r.x + 10, y: r.y + r.h * 0.7 }) });
    expect(drop()?.dataset.position).toBe('bottom');
    expect(el.style.transform).toMatch(/translateY\(\d+(\.\d+)?px\)/);
    expect(declarations('.ad-usage-drop')).toMatch(/background:\s*var\(--guide\)/);
    expect(declarations('.ad-usage-strip--dragging')).toMatch(/border-color:\s*var\(--guide\)/);
    fireEvent.pointerUp(grip, { pointerId: 1, ...toScreen(c, { x: r.x + 10, y: r.y + r.h * 0.7 }) });
    await waitFor(() => expect(strip(CLAUDE)?.dataset.position).toBe('bottom'));
    expect(drop()).toBeNull();
    expect(strip(CLAUDE)!.style.transform).toBe('');
    expect(data(c, CLAUDE).usage).toEqual({ on: true, position: 'bottom' });
    // 拖回上边：只看在窗口的上半还是下半，拖到窗口外很远也只是贴在上边
    const grip2 = strip(CLAUDE)!.querySelector<HTMLElement>('.ad-usage-grip')!;
    fireEvent.pointerDown(grip2, { pointerId: 2, button: 0, ...toScreen(c, { x: r.x + 10, y: r.y + r.h + 18 }) });
    fireEvent.pointerMove(grip2, { pointerId: 2, ...toScreen(c, { x: r.x - 500, y: r.y - 400 }) });
    expect(drop()?.dataset.position).toBe('top');
    fireEvent.pointerUp(grip2, { pointerId: 2, ...toScreen(c, { x: r.x - 500, y: r.y - 400 }) });
    await waitFor(() => expect(strip(CLAUDE)?.dataset.position).toBe('top'));
    // 没离开终端：还在这个窗口节点里，窗口没动
    expect(strip(CLAUDE)!.parentElement).toBe(node(CLAUDE));
    expect(c.windowById(CLAUDE)!.rect).toEqual(r);
    // 贴到下边后保存，重启后还在下边
    act(() => {
      const g = strip(CLAUDE)!.querySelector<HTMLElement>('.ad-usage-grip')!;
      fireEvent.pointerDown(g, { pointerId: 3, button: 0, ...toScreen(c, { x: r.x + 10, y: r.y - 18 }) });
      fireEvent.pointerUp(g, { pointerId: 3, ...toScreen(c, { x: r.x + 10, y: r.y + r.h }) });
    });
    await waitFor(() => expect(data(c, CLAUDE).usage).toEqual({ on: true, position: 'bottom' }));
    await c.flush();
    const saved = api.fakes.board.current()!.windows.find((w) => w.id === CLAUDE)!.data as TerminalWindowData;
    expect(saved.usage).toEqual({ on: true, position: 'bottom' });
    c.dispose();
    cleanup();
    const again = new BoardController({ api, registry: registry() });
    render(<Workbench api={api} controller={again} />);
    await waitFor(() => expect(strip(CLAUDE)?.dataset.position).toBe('bottom'));
    expect(item(windowMenu(again, CLAUDE), 'Usage').checked).toBe(true);
    again.dispose();
  });

  it('maximizing leaves room for the strip on its edge', async () => {
    const api = seeded();
    const c = new BoardController({ api, registry: registry() });
    await c.start();
    c.setPane({ w: 1200, h: 800 });
    act(() => item(windowMenu(c, CLAUDE), 'Usage').onSelect?.());
    const w = c.windowById(CLAUDE)!;
    expect(usageOutset(w)).toEqual({ top: 30, bottom: 0 });
    c.toggleMaximize(CLAUDE);
    const max = c.windowById(CLAUDE)!.rect;
    expect(max.h).toBe(800 - 32 - 30);
    expect(c.state.viewport.y).toBe(-max.y + 16 + 30);
    c.toggleMaximize(CLAUDE);
    // 贴在下边：上边照常，下边留出来
    act(() => setUsage(c, CLAUDE, { position: 'bottom' }));
    expect(usageOutset(c.windowById(CLAUDE)!)).toEqual({ top: 0, bottom: 30 });
    c.toggleMaximize(CLAUDE);
    expect(c.windowById(CLAUDE)!.rect.h).toBe(800 - 32 - 30);
    expect(c.state.viewport.y).toBe(-max.y + 16);
    // 关着时不留
    c.toggleMaximize(CLAUDE);
    act(() => setUsage(c, CLAUDE, { on: false }));
    c.toggleMaximize(CLAUDE);
    expect(c.windowById(CLAUDE)!.rect.h).toBe(800 - 32);
    c.dispose();
  });
});

describe('PL2 the popover', () => {
  it('click shows model + window, last request, requests; Move to bottom / top and Hide', async () => {
    const { api, c } = await setup();
    const el = await turnOn(c, CLAUDE);
    await waitFor(() => expect(el.dataset.state).toBe('ok'));
    fireEvent.click(el.querySelector('.ad-usage-body')!);
    const card = await screen.findByRole('dialog', { name: 'Usage details' });
    const q = within(card);
    expect(q.getByText('claude-opus-5-5')).toBeTruthy();
    expect(q.getByText('Context window 200k')).toBeTruthy();
    expect(q.getByText('Input 2.1k · Output 640 · Cache 94k')).toBeTruthy();
    expect(card.querySelector('[data-row="requests"]')!.textContent).toBe('Requests37');
    expect(card.querySelector('[data-row="limit"]')).toBeNull();
    fireEvent.click(q.getByRole('button', { name: 'Move to bottom' }));
    await waitFor(() => expect(strip(CLAUDE)?.dataset.position).toBe('bottom'));
    expect(screen.queryByRole('dialog', { name: 'Usage details' })).toBeNull();
    fireEvent.click(strip(CLAUDE)!.querySelector('.ad-usage-body')!);
    const card2 = await screen.findByRole('dialog', { name: 'Usage details' });
    expect(within(card2).getByRole('button', { name: 'Move to top' })).toBeTruthy();
    expect(api.fakes.usage.watching.has(T.loginClaude)).toBe(true);
    fireEvent.click(within(card2).getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(strip(CLAUDE)).toBeNull());
    expect(data(c, CLAUDE).usage).toEqual({ on: false, position: 'bottom' });
    expect(item(windowMenu(c, CLAUDE), 'Usage').checked).toBe(false);
    await waitFor(() => expect(api.fakes.usage.watching.has(T.loginClaude)).toBe(false));
    c.dispose();
  });

  it('codex adds the 5h and weekly limits, written like codex /status (% left)', async () => {
    const { c } = await setup();
    const el = await turnOn(c, CODEX);
    await waitFor(() => expect(el.dataset.state).toBe('ok'));
    fireEvent.click(el.querySelector('.ad-usage-body')!);
    const card = await screen.findByRole('dialog', { name: 'Usage details' });
    const rows = [...card.querySelectorAll('[data-row="limit"]')].map((r) => r.textContent);
    expect(rows).toEqual(['5h limit77% left', 'Weekly limit59% left']);
    expect(within(card).getByText('Input 8.4K · Output 1.2K · Cache 228K')).toBeTruthy();
    expect(within(card).getByText('Context window 272K')).toBeTruthy();
    c.dispose();
  });

  it('no data: the card says so with the reason and still offers Move and Hide', async () => {
    const { c } = await setup();
    const el = await turnOn(c, SHOP);
    await waitFor(() => expect(el.dataset.state).toBe('no-data'));
    fireEvent.click(el.querySelector('.ad-usage-body')!);
    const card = await screen.findByRole('dialog', { name: 'Usage details' });
    expect(within(card).getByText('No usage data')).toBeTruthy();
    expect(within(card).getByText('No session file yet')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Hide' })).toBeTruthy();
    c.dispose();
  });
});

describe('PL2 watch / unwatch', () => {
  it('watches only while the strip is shown: on → watch, off → unwatch, close the window → unwatch', async () => {
    const { api, c } = await setup();
    // 开插件之前谁也不 watch
    expect(api.fakes.usage.watching.size).toBe(0);
    await turnOn(c, CLAUDE);
    await turnOn(c, CODEX);
    await waitFor(() => expect([...api.fakes.usage.watching].sort()).toEqual([T.loginClaude, T.loginCodex].sort()));
    act(() => item(windowMenu(c, CLAUDE), 'Usage').onSelect?.());
    await waitFor(() => expect([...api.fakes.usage.watching]).toEqual([T.loginCodex]));
    // 关着时的变化不发事件，也不画
    act(() => void api.fakes.usage.set(T.loginClaude, { requests: 99 }));
    expect(api.bus.log.filter((e) => e.type === 'usage.changed' && e.usage.terminalId === T.loginClaude)).toHaveLength(0);
    // 关窗口（codex 在跑，先确认 Stop and close）
    await act(() => c.stopAndClose(CODEX));
    await waitFor(() => expect(api.fakes.usage.watching.size).toBe(0));
    c.dispose();
  });

  it('a terminal whose terminalId changes is unwatched and the new id watched', async () => {
    const { api, c } = await setup();
    await turnOn(c, CLAUDE);
    await waitFor(() => expect(api.fakes.usage.watching.has(T.loginClaude)).toBe(true));
    act(() => c.updateData(CLAUDE, { terminalId: 'term-new' as TerminalId }));
    await waitFor(() => expect([...api.fakes.usage.watching]).toEqual(['term-new']));
    c.dispose();
  });
});

describe('PL2 formatting', () => {
  const base = { state: 'ok', reason: null, match: 'exact', model: null, total: null, last: null, requests: 1, updatedAt: '' } as const;
  const usageOf = (agent: string, tokens: number, window: number | null, percent: number | null = null) =>
    ({ ...base, agent, context: { tokens, window, percent, windowSource: 'agent' } }) as unknown as TerminalUsage;

  it('IS-69: the context cell reads like each agent’s own screen (acceptance numbers)', () => {
    // kimi 截图里的一组：70,450 / 1,000,000 → kimi 写 68.8k/977k、8%（1024 进位，向上取整）
    expect(contextDisplay(usageOf('kimi', 70_450, 1_000_000, 7.045))).toEqual({ used: '68.8k', window: '977k', percent: 8, percentText: '8%' });
    expect(abbreviate1024(262_144)).toBe('256k');
    // codex：27,756 / 475,000 → /status 写 “97% left (27.8K used / 475K)”，先扣 12000 的基线；条上用了 3%
    expect(contextDisplay(usageOf('codex', 27_756, 475_000, 5.8))).toEqual({ used: '27.8K', window: '475K', percent: 3, percentText: '97% left' });
    expect(contextDisplay(usageOf('codex', 22_957, 475_000, 4.8))).toEqual({ used: '23K', window: '475K', percent: 2, percentText: '98% left' });
    // claude：52,476 / 1,000,000 → /context 写 “52.5k/1m tokens (5%)”
    expect(contextDisplay(usageOf('claude', 52_476, 1_000_000, 5.2))).toEqual({ used: '52.5k', window: '1m', percent: 5, percentText: '5%' });
    expect(contextDisplay(usageOf('claude', 96_000, 200_000, 48))).toEqual({ used: '96k', window: '200k', percent: 48, percentText: '48%' });
    // pi：底栏 “5.2%/1.0M”（一位小数；1.0M 不去 .0）
    expect(contextDisplay(usageOf('pi', 52_476, 1_000_000, 5.2))).toMatchObject({ used: '52k', window: '1.0M', percentText: '5.2%' });
    expect(contextDisplay(usageOf('pi', 52_476, 1_000_000))?.percent).toBeCloseTo(5.2476, 6);
    expect(contextDisplay(usageOf('pi', 1_234, 200_000, 0.6))).toMatchObject({ used: '1.2k', window: '200k', percentText: '0.6%' });
    // omp：状态栏 “5.2%/1M”（大写 K / M，去 .0）
    expect(contextDisplay(usageOf('omp', 52_476, 1_000_000, 5.2))).toMatchObject({ used: '52K', window: '1M', percentText: '5.2%' });
    expect(contextDisplay(usageOf('omp', 1_500, 272_000, 0.6))?.used).toBe('1.5K');
  });

  it('percent edge cases follow each agent', () => {
    // codex 的窗口不大于基线时 codex 写 0% left
    expect(contextDisplay(usageOf('codex', 5_000, 12_000))?.percentText).toBe('0% left');
    // 不知道窗口：codex 只写用量；claude 用服务报的百分比
    expect(contextDisplay(usageOf('codex', 27_756, null))).toEqual({ used: '27.8K', window: null, percent: null, percentText: null });
    expect(contextDisplay(usageOf('claude', 52_476, null, 5.2))?.percentText).toBe('5%');
    // kimi 有一点就至少 1%
    expect(contextDisplay(usageOf('kimi', 10, 1_000_000))?.percentText).toBe('1%');
    // 超过窗口：进度条夹在 100，字照 agent（claude 不夹）
    expect(contextDisplay(usageOf('claude', 210_000, 200_000))).toMatchObject({ percent: 100, percentText: '105%' });
    expect(AGENT_FORMATS.codex.contextPercent(600_000, 475_000, null)).toEqual({ value: 100, text: '0% left' });
  });

  it('token counts in each agent’s own style', () => {
    // claude formatTokens：Intl compact，小写，去 .0
    expect(claudeTokens(640)).toBe('640');
    expect(claudeTokens(1_000)).toBe('1k');
    expect(claudeTokens(52_476)).toBe('52.5k');
    expect(claudeTokens(1_250_000)).toBe('1.3m');
    expect(claudeTokens(999_950)).toBe('1m');
    // codex format_tokens_compact：<10 两位、<100 一位，Rust 的一半取偶
    expect(codexTokens(0)).toBe('0');
    expect(codexTokens(640)).toBe('640');
    expect(codexTokens(1_000)).toBe('1K');
    expect(codexTokens(1_234)).toBe('1.23K');
    expect(codexTokens(1_125)).toBe('1.12K');
    expect(codexTokens(27_756)).toBe('27.8K');
    expect(codexTokens(475_000)).toBe('475K');
    expect(codexTokens(999_999)).toBe('1000K');
    expect(codexTokens(1_500_000)).toBe('1.5M');
    // pi formatTokens
    expect(piTokens(999)).toBe('999');
    expect(piTokens(1_000)).toBe('1.0k');
    expect(piTokens(52_476)).toBe('52k');
    expect(piTokens(1_000_000)).toBe('1.0M');
    expect(piTokens(12_400_000)).toBe('12M');
    // omp formatNumber
    expect(ompTokens(1_000)).toBe('1K');
    expect(ompTokens(1_500)).toBe('1.5K');
    expect(ompTokens(52_476)).toBe('52K');
    expect(ompTokens(1_000_000)).toBe('1M');
    expect(ompTokens(2_500_000_000)).toBe('2.5B');
    // 不认识的 agent 照旧
    expect(tokensText(null, 18_400)).toBe('18.4k');
    expect(tokensText('codex', null)).toBe('–');
  });

  it('rustFixed rounds like Rust format! (exact value, ties to even)', () => {
    expect(rustFixed(2.5, 0)).toBe('2');
    expect(rustFixed(3.5, 0)).toBe('4');
    expect(rustFixed(0.5, 0)).toBe('0');
    expect(rustFixed(1.125, 2)).toBe('1.12');
    expect(rustFixed(1.135, 2)).toBe('1.14');
    expect(rustFixed(12.25, 1)).toBe('12.2');
    expect(rustFixed(27.756, 1)).toBe('27.8');
    expect(rustFixed(99.95, 1)).toBe('100.0');
    expect(rustFixed(9.995, 2)).toBe('9.99');
    expect(rustFixed(0.05, 2)).toBe('0.05');
  });

  it('abbreviates with k / M (agents we do not know)', () => {
    expect(abbreviate(640)).toBe('640');
    expect(abbreviate(2_100)).toBe('2.1k');
    expect(abbreviate(18_400)).toBe('18.4k');
    expect(abbreviate(96_000)).toBe('96k');
    expect(abbreviate(312_000)).toBe('312k');
    expect(abbreviate(999_960)).toBe('1M');
    expect(abbreviate(1_400_000)).toBe('1.4M');
    expect(abbreviate(12_345_678)).toBe('12.3M');
    expect(abbreviate(null)).toBe('–');
    expect(cacheText({ input: 0, output: 0, cacheRead: 1_400_000, cacheWrite: 86_000, reasoning: null })).toBe('1.4M / 86k');
    expect(cacheText({ input: 0, output: 0, cacheRead: 1_400_000, cacheWrite: null, reasoning: null })).toBe('1.4M');
    expect(lastRequestText({ input: 2_100, output: 640, cacheRead: 94_000, cacheWrite: 1_200, reasoning: null })).toBe('Input 2.1k · Output 640 · Cache 94k / 1.2k');
    expect(lastRequestText({ input: 2_100, output: 640, cacheRead: 94_000, cacheWrite: 1_200, reasoning: null }, 'codex')).toBe('Input 2.1K · Output 640 · Cache 94K / 1.2K');
  });

  it('names the codex limit windows like codex (5h / Weekly …, ±5%)', () => {
    const w = (windowMinutes: number | null) => ({ usedPercent: 1, windowMinutes, resetsAt: null });
    expect(limitLabel(w(300))).toBe('5h limit');
    expect(limitLabel(w(290))).toBe('5h limit');
    expect(limitLabel(w(1440))).toBe('Daily limit');
    expect(limitLabel(w(10080))).toBe('Weekly limit');
    expect(limitLabel(w(43_200))).toBe('Monthly limit');
    expect(limitLabel(w(120))).toBe('Usage limit');
    expect(limitLabel(w(null))).toBe('Usage limit');
    expect(limitLabel(w(null), true)).toBe('Secondary usage limit');
  });

  it('IS-69: codex limits read “% left” after codex rounds used_percent (0.6 → 99% left)', () => {
    const lim = (usedPercent: number) => ({ usedPercent, windowMinutes: 300, resetsAt: null });
    const now = new Date(2026, 9, 25, 9, 0);
    // 验收时：codex /status 写 “5h limit … 99% left”，会话文件里的 used_percent 是 0.x
    expect(codexLimitText(lim(0.6), now, '24h')).toBe('99% left');
    expect(codexLimitText(lim(0.5), now, '24h')).toBe('99% left');
    // app-server 先四舍五入成整数：0.4 → 0 → codex 写 100% left
    expect(codexLimitText(lim(0.4), now, '24h')).toBe('100% left');
    expect(codexLimitText(lim(23.4), now, '24h')).toBe('77% left');
    expect(codexLimitText(lim(100), now, '24h')).toBe('0% left');
    expect(codexLimitText(lim(130), now, '24h')).toBe('0% left');
  });

  it('codex reset times: same day only the time, otherwise “on 27 Oct”; 12h or 24h like the system', () => {
    const now = new Date(2026, 9, 25, 9, 0);
    const today = new Date(2026, 9, 25, 14, 5).toISOString();
    const later = new Date(2026, 9, 27, 8, 30).toISOString();
    const midnight = new Date(2026, 9, 25, 0, 5).toISOString();
    expect(codexResetTime(today, now, '24h')).toBe('14:05');
    expect(codexResetTime(today, now, '12h')).toBe('2:05 PM');
    expect(codexResetTime(later, now, '24h')).toBe('08:30 on 27 Oct');
    expect(codexResetTime(later, now, '12h')).toBe('8:30 AM on 27 Oct');
    expect(codexResetTime(midnight, now, '12h')).toBe('12:05 AM');
    expect(codexResetTime('nope', now, '24h')).toBe('');
    const rows = limitRows(
      {
        ...(CODEX_USAGE as TerminalUsage),
        rateLimits: {
          primary: { usedPercent: 0.6, windowMinutes: 300, resetsAt: today },
          secondary: { usedPercent: 0.4, windowMinutes: 10080, resetsAt: later },
        },
      },
      now,
      '24h',
    );
    expect(rows).toEqual([
      { label: '5h limit', text: '99% left (resets 14:05)' },
      { label: 'Weekly limit', text: '100% left (resets 08:30 on 27 Oct)' },
    ]);
  });
});
