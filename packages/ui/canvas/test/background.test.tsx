// N10：后台 agent——小提示的文字、点开侧边栏、选中看记录（只读）、你发下一条消息后提示消失、
// 主终端是窗口组 lead 时并进 N2 的侧边栏、终端关了面板收起、右键菜单的 Background agents…。
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BackgroundAgent, TerminalId, TerminalWindowData, WindowComponentProps, WindowGroupMemberRequest } from '@agentdeck/contracts';
import { createFakeApi, fakeBackgroundAgent, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { agentElapsedMs, formatElapsed, formatTokens, hintOf, transcriptRect } from '../src/model/background.ts';
import { innerArea } from '../src/model/geometry.ts';
import { dockSlot, groupView, hiddenMembers, listGroups, sidebarRect } from '../src/model/groups.ts';
import { PLUGIN_MARK_HEIGHT } from '../src/plugins/types.ts';
import { Workbench } from '../src/react/Workbench.tsx';
import { createWindowRegistry } from '../src/registry.ts';

const W = SAMPLE.workspaces;
const T = SAMPLE.terminals;
const TID = T.loginClaude as TerminalId;

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

const agent = (id: string, patch: Partial<BackgroundAgent> = {}) => fakeBackgroundAgent(TID, { id, description: `Weather ${id}`, ...patch });
const five = () => [
  agent('a1'),
  agent('a2'),
  agent('a3'),
  agent('a4', { state: 'done', endedAt: '2026-10-26T09:00:09.000Z', durationMs: 9000, tokens: 40800 }),
  agent('a5', { state: 'done', endedAt: '2026-10-26T09:00:09.000Z', durationMs: 9000 }),
];

let api: FakeApi;
let c: BoardController;

async function mount() {
  api = createFakeApi();
  c = new BoardController({ api, registry: registry() });
  render(<Workbench api={api} controller={c} />);
  await waitFor(() => expect(c.state.loaded).toBe(true));
}

afterEach(() => {
  c?.dispose();
  api?.dispose();
});

const lead = () => c.state.windows.find((w) => (w.data as Partial<TerminalWindowData>).terminalId === TID)!;
const hint = () => document.querySelector<HTMLButtonElement>('.ad-bg-hint');
const bgRows = () => [...document.querySelectorAll<HTMLButtonElement>('.ad-bg-row')];
const transcript = () => document.querySelector<HTMLElement>('.ad-bg-transcript');

describe('background agents · model', () => {
  it('the hint counts this round: running, failed, all done', () => {
    expect(hintOf([])).toBeNull();
    expect(hintOf(five())).toMatchObject({ tone: 'running', text: '5 background agents · 3 running' });
    expect(hintOf([agent('a1', { state: 'failed' }), agent('a2')])).toMatchObject({ tone: 'error', text: '2 background agents · 1 failed · 1 running' });
    expect(hintOf([agent('a1', { state: 'done' })])).toMatchObject({ tone: 'done', text: '✓ 1 done' });
    // 你发了下一条消息：做完的不算这一轮
    expect(hintOf([agent('a1', { state: 'done', current: false })])).toBeNull();
  });

  it('formats time and tokens', () => {
    expect(formatElapsed(9000)).toBe('9s');
    expect(formatElapsed(62_000)).toBe('1m 2s');
    expect(formatTokens(40_800)).toBe('40.8k tokens');
    expect(agentElapsedMs(agent('a1'), Date.parse('2026-10-26T09:00:12.000Z'))).toBe(12_000);
  });
});

describe('background agents · Workbench', () => {
  it('shows the hint, opens the sidebar, and shows a read-only transcript for the selected agent', async () => {
    await mount();
    expect(hint()).toBeNull();
    act(() => api.fakes.subagents.set(TID, five()));
    await waitFor(() => expect(hint()?.textContent).toBe('5 background agents · 3 running'));
    expect(hint()!.dataset.tone).toBe('running');

    fireEvent.click(hint()!);
    await waitFor(() => expect(document.querySelector('.ad-bg-sidebar')).not.toBeNull());
    expect(document.querySelector('.ad-bg-sidebar .ad-group-sidebar-head')!.textContent).toBe('5 background agents');
    expect(bgRows().map((r) => r.querySelector('.ad-group-row-name')!.textContent)).toEqual(['Weather a1', 'Weather a2', 'Weather a3', 'Weather a4', 'Weather a5']);
    expect(bgRows()[3]!.dataset.state).toBe('done');
    expect(bgRows()[3]!.querySelector('.ad-bg-time')!.textContent).toBe('9s');
    expect(c.state.backgroundPanels[lead().id]).toEqual({ selected: null });

    act(() => api.fakes.subagents.setTranscript(TID, 'a3', [{ kind: 'prompt', text: 'Look up the weather' }]));
    fireEvent.click(bgRows()[2]!);
    await waitFor(() => expect(transcript()?.textContent).toContain('› Look up the weather'));
    expect(transcript()!.textContent).toContain('Read-only');
    expect(transcript()!.textContent).toContain('This agent runs inside claude. To change or stop it, tell the main agent.');
    expect(transcript()!.querySelector('textarea, input')).toBeNull();
    expect(api.fakes.subagents.watching.size).toBe(1);
    // 新的一行跟着出现
    act(() => api.fakes.subagents.setTranscript(TID, 'a3', [{ kind: 'prompt', text: 'Look up the weather' }, { kind: 'tool', text: 'WebSearch beijing' }]));
    await waitFor(() => expect(transcript()!.textContent).toContain('⏺ WebSearch beijing'));

    // 再点一次同一行收起记录，停止跟踪；Collapse 收起侧边栏
    fireEvent.click(bgRows()[2]!);
    await waitFor(() => expect(transcript()).toBeNull());
    expect(api.fakes.subagents.watching.size).toBe(0);
    fireEvent.click(document.querySelector<HTMLButtonElement>('.ad-bg-sidebar .ad-group-sidebar-actions button')!);
    await waitFor(() => expect(document.querySelector('.ad-bg-sidebar')).toBeNull());
  });

  it('places the sidebar right of the terminal and the transcript at the dock slot', async () => {
    await mount();
    act(() => api.fakes.subagents.set(TID, five()));
    act(() => c.openBackgroundPanel(lead().id));
    act(() => c.selectBackgroundAgent(lead().id, 'a1'));
    await waitFor(() => expect(transcript()).not.toBeNull());
    const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
    const r = lead().rect;
    expect(node(`bg-sidebar:${lead().id}`).style.width).toBe(`${sidebarRect(r).w}px`);
    expect(transcriptRect(r)).toMatchObject(dockSlot(r));
  });

  it('turns grey when all are done, and disappears after your next message', async () => {
    await mount();
    act(() => api.fakes.subagents.set(TID, [agent('a1', { state: 'done' }), agent('a2', { state: 'done' })]));
    await waitFor(() => expect(hint()?.textContent).toBe('✓ 2 done'));
    expect(hint()!.dataset.tone).toBe('done');
    act(() => api.fakes.subagents.set(TID, [agent('a1', { state: 'done', current: false }), agent('a2', { state: 'done', current: false })]));
    await waitFor(() => expect(hint()).toBeNull());
    // 记录还在：右键菜单的 Background agents… 还能打开
    expect(c.backgroundAgentsOf(lead().id)).toHaveLength(2);
    act(() => c.openMenu({ screen: { x: 10, y: 10 }, flow: { x: 0, y: 0 }, target: { kind: 'window', windowId: lead().id } }));
    const item = await waitFor(() => {
      const el = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.includes('Background agents…'));
      expect(el).toBeDefined();
      return el!;
    });
    fireEvent.click(item);
    await waitFor(() => expect(document.querySelector('.ad-bg-sidebar')).not.toBeNull());
  });

  it('a failed agent turns the hint red; the panel closes when the terminal has none left', async () => {
    await mount();
    act(() => api.fakes.subagents.set(TID, [agent('a1', { state: 'failed', reason: 'Interrupted' }), agent('a2')]));
    await waitFor(() => expect(hint()?.dataset.tone).toBe('error'));
    act(() => c.openBackgroundPanel(lead().id));
    await waitFor(() => expect(bgRows()[0]!.querySelector('.ad-bg-time')!.textContent).toBe('Failed'));
    act(() => api.fakes.subagents.set(TID, []));
    await waitFor(() => expect(document.querySelector('.ad-bg-sidebar')).toBeNull());
    expect(c.state.backgroundPanels).toEqual({});
    expect(hint()).toBeNull();
  });

  it('picks up agents that were already running when the board loads', async () => {
    api = createFakeApi();
    api.fakes.subagents.set(TID, five());
    c = new BoardController({ api, registry: registry() });
    render(<Workbench api={api} controller={c} />);
    await waitFor(() => expect(hint()?.textContent).toBe('5 background agents · 3 running'));
  });
});

describe('background agents · with a window group (N2)', () => {
  const member = (tid: string, label: string): WindowGroupMemberRequest => ({
    request: {
      type: 'terminal',
      data: { terminalId: tid as TerminalId, agent: 'claude', cmd: 'claude', args: [], cwd: SAMPLE.paths.agentdeckLogin, sessionId: null, startCommand: null },
      workspaceId: W.agentdeckLogin,
    },
    label,
  });

  it('joins the group sidebar; picking a background agent collapses the sub-terminals, picking a sub-terminal closes the transcript', async () => {
    await mount();
    act(() => api.bus.emit({ type: 'board.open-group', lead: T.loginClaude, members: [member('sub-1', 'api'), member('sub-2', 'ui')], highlight: false }));
    act(() => api.fakes.subagents.set(TID, [agent('a1'), agent('a2', { state: 'done' })]));
    act(() => c.openBackgroundPanel(lead().id));
    const sidebar = () => document.querySelector<HTMLElement>('.ad-group-sidebar[data-group-id]')!;
    await waitFor(() => expect(sidebar().querySelector('.ad-group-sidebar-head')!.textContent).toBe('4 subagents'));
    expect([...sidebar().querySelectorAll('.ad-bg-section')].map((e) => e.textContent)).toEqual(['TERMINALS', 'BACKGROUND · READ-ONLY']);
    // lead 不另画一列
    expect(document.querySelector('.ad-bg-sidebar')).toBeNull();

    const g = () => listGroups(c.state.windows)[0]!;
    fireEvent.click(sidebar().querySelector<HTMLButtonElement>('.ad-bg-row[data-agent-id="a1"]')!);
    await waitFor(() => expect(transcript()).not.toBeNull());
    expect(groupView(g()).mode).toBe('collapsed');
    expect(hiddenMembers(c.state.windows).size).toBe(2);

    act(() => c.selectGroupMember(g().members[1]!.id));
    await waitFor(() => expect(transcript()).toBeNull());
    expect(c.state.backgroundPanels[lead().id]).toEqual({ selected: null });
    expect(groupView(g())).toEqual({ mode: 'one', shown: g().members[1]!.id });
  });
});

describe('background agents · the frame holds the panel and the marks', () => {
  const frameOfLead = () => c.frameOf(lead().workspaceId)!.rect;
  const contains = (outer: { x: number; y: number; w: number; h: number }, inner: { x: number; y: number; w: number; h: number }) =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
  const layout = () => JSON.stringify([c.state.frames.map((f) => f.rect), c.state.windows.map((w) => [w.id, w.rect])]);

  it('opening the panel grows the frame around the sidebar and the transcript; closing puts everything back', async () => {
    await mount();
    act(() => api.fakes.subagents.set(TID, five()));
    await waitFor(() => expect(hint()).not.toBeNull());
    await act(async () => {});
    const before = layout();
    const f0 = frameOfLead();

    act(() => c.openBackgroundPanel(lead().id));
    const r = lead().rect;
    expect(contains(innerArea(frameOfLead()), sidebarRect(r))).toBe(true);
    const sidebarOnly = layout();
    act(() => c.selectBackgroundAgent(lead().id, 'a1'));
    expect(contains(innerArea(frameOfLead()), transcriptRect(r))).toBe(true);
    // 框里被盖住的窗口挪开了
    for (const w of c.state.windows) {
      if (w.id === lead().id || w.workspaceId !== lead().workspaceId) continue;
      expect(overlaps(w.rect, sidebarRect(r)) || overlaps(w.rect, transcriptRect(r))).toBe(false);
    }
    expect(frameOfLead().w).toBeGreaterThan(f0.w);
    // 收起记录窗口：回到只开侧边栏时的样子
    await act(async () => {});
    act(() => c.selectBackgroundAgent(lead().id, 'a1'));
    expect(layout()).toBe(sidebarOnly);
    act(() => c.closeBackgroundPanel(lead().id));
    expect(layout()).toBe(before);
  });

  it('a frame grows to hold the hint under a terminal at its bottom edge', async () => {
    await mount();
    const f = frameOfLead();
    const inner = innerArea(f);
    // 把主终端放到框的最下面，正好贴着内边
    act(() => c.store.setState((s) => ({ windows: s.windows.map((w) => (w.id === lead().id ? { ...w, rect: { ...w.rect, y: inner.y + inner.h - w.rect.h } } : w)) })));
    await act(async () => {});
    expect(frameOfLead().h).toBe(f.h);
    act(() => api.fakes.subagents.set(TID, five()));
    await waitFor(() => expect(frameOfLead().h).toBe(f.h + PLUGIN_MARK_HEIGHT));
  });
});

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
