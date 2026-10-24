// N2：窗口组的侧边栏（形态 A）——行和状态灯、选中一行只显示它、Show all / Collapse group、跟着 lead 走、
// ⌘J 跳到收起的、在等你的子终端时把它显示出来、关掉 lead 侧边栏消失、子终端变普通窗口、保存和恢复。
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rect, TerminalId, TerminalWindowData, WindowComponentProps, WindowGroupMemberRequest, WindowGroupRef, WindowId, WindowNode } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import {
  dockSlot,
  groupView,
  hiddenMembers,
  lampOf,
  listGroups,
  memberName,
  sidebarRect,
  syncGroups,
} from '../src/model/groups.ts';
import { Workbench } from '../src/react/Workbench.tsx';
import { createWindowRegistry } from '../src/registry.ts';

const W = SAMPLE.workspaces;
const T = SAMPLE.terminals;

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

const member = (tid: string, label: string | null): WindowGroupMemberRequest => ({
  request: {
    type: 'terminal',
    data: { terminalId: tid as TerminalId, agent: 'claude', cmd: 'claude', args: [], cwd: SAMPLE.paths.agentdeckLogin, sessionId: null, startCommand: null },
    workspaceId: W.agentdeckLogin,
  },
  label,
});
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

let api: FakeApi;
let c: BoardController;

async function boot(a: FakeApi): Promise<BoardController> {
  const ctl = new BoardController({ api: a, registry: registry(), homeDir: SAMPLE.home });
  ctl.setPane({ w: 1600, h: 1000 });
  await ctl.start();
  return ctl;
}

const byTerminal = (tid: string) => c.state.windows.find((w) => (w.data as Partial<TerminalWindowData>).terminalId === tid)!;
const lead = () => byTerminal(T.loginClaude);
const subs = () => ['sub-1', 'sub-2', 'sub-3'].map(byTerminal);
const group = () => listGroups(c.state.windows)[0]!;
const visibleInFrame = () => {
  const hidden = hiddenMembers(c.state.windows);
  return c.state.windows.filter((w) => w.workspaceId === W.agentdeckLogin && !hidden.has(w.id));
};

function openThree() {
  api.bus.emit({ type: 'board.open-group', lead: T.loginClaude, members: [member('sub-1', 'api'), member('sub-2', 'ui'), member('sub-3', 'tests')], highlight: false });
}

beforeEach(async () => {
  api = createFakeApi();
  c = await boot(api);
});

afterEach(() => {
  c.dispose();
  api.dispose();
});

describe('group sidebar · controller', () => {
  it('a new group shows the first sub-terminal beside the sidebar and collapses the others', () => {
    openThree();
    const [s1, s2, s3] = subs();
    expect(groupView(group())).toEqual({ mode: 'one', shown: s1!.id });
    expect(hiddenMembers(c.state.windows)).toEqual(new Set([s2!.id, s3!.id]));
    expect(s1!.rect).toMatchObject(dockSlot(lead().rect));
    // 侧边栏、显示的子终端都不盖住框里别的窗口，框装得下
    for (const w of visibleInFrame()) if (w.id !== lead().id) expect(overlaps(sidebarRect(lead().rect), w.rect)).toBe(false);
    const f = c.frameOf(W.agentdeckLogin)!.rect;
    expect(s1!.rect.x + s1!.rect.w).toBeLessThanOrEqual(f.x + f.w);
  });

  it('selecting a row shows only that sub-terminal, docked right of the sidebar, and focuses it', () => {
    openThree();
    const [s1, s2] = subs();
    c.selectGroupMember(s2!.id);
    expect(groupView(group())).toEqual({ mode: 'one', shown: s2!.id });
    expect(hiddenMembers(c.state.windows).has(s1!.id)).toBe(true);
    expect(hiddenMembers(c.state.windows).has(s2!.id)).toBe(false);
    expect(byTerminal('sub-2').rect).toMatchObject(dockSlot(lead().rect));
    expect(c.state.focusedId).toBe(s2!.id);
  });

  it('Show all lays every sub-terminal out as normal windows; Collapse group hides them all', () => {
    openThree();
    c.focusWindow(subs()[0]!.id);
    c.showAllGroup(group().id);
    expect(groupView(group()).mode).toBe('all');
    expect(hiddenMembers(c.state.windows).size).toBe(0);
    const inFrame = visibleInFrame();
    for (const a of inFrame) for (const b of inFrame) if (a.id !== b.id) expect(overlaps(a.rect, b.rect)).toBe(false);
    for (const s of subs()) {
      expect(s.rect.x).toBeGreaterThanOrEqual(dockSlot(lead().rect).x);
      expect(overlaps(s.rect, sidebarRect(lead().rect))).toBe(false);
    }

    c.collapseGroup(group().id);
    expect(groupView(group()).mode).toBe('collapsed');
    expect(hiddenMembers(c.state.windows)).toEqual(new Set(subs().map((s) => s.id)));
    // 聚焦的子终端收起了，取消聚焦
    expect(c.state.focusedId).toBeNull();
  });

  it('the docked sub-terminal and the collapsed ones move with the lead', () => {
    openThree();
    const before = lead().rect;
    c.moveWindowStart(lead().id);
    c.moveWindow(lead().id, 0, 200, { x: before.x + 10, y: before.y + 210 });
    c.moveWindowEnd(lead().id);
    const slot = dockSlot(lead().rect);
    expect(lead().rect.y).not.toBe(before.y);
    for (const s of subs()) expect(s.rect).toMatchObject(slot);
    // 框装得下 lead、侧边栏和显示的子终端
    const f = c.frameOf(W.agentdeckLogin)!.rect;
    expect(subs()[0]!.rect.y + subs()[0]!.rect.h).toBeLessThanOrEqual(f.y + f.h);
  });

  it('⌘J to a waiting sub-terminal that is collapsed shows it; it still counts as waiting', () => {
    openThree();
    c.collapseGroup(group().id);
    api.fakes.status.track('sub-2' as TerminalId, { agent: 'claude', workspaceId: W.agentdeckLogin }, 'running');
    api.fakes.status.requestApproval('sub-2' as TerminalId, { summary: 'Edit src/ui/LoginForm.tsx' });
    const s2 = byTerminal('sub-2').id;
    expect(c.attention().waiting).toContain(s2);
    let hit: WindowId | null = null;
    for (let i = 0; i < 5 && hit !== s2; i++) hit = c.runShortcut('next-waiting') ? c.state.focusedId : null;
    expect(hit).toBe(s2);
    expect(groupView(group())).toEqual({ mode: 'one', shown: s2 });
    expect(hiddenMembers(c.state.windows).has(s2)).toBe(false);
    expect(byTerminal('sub-2').rect).toMatchObject(dockSlot(lead().rect));
  });

  it('closing the shown sub-terminal shows the next one', async () => {
    openThree();
    const [s1, s2] = subs();
    await c.stopAndClose(s1!.id);
    expect(groupView(group())).toEqual({ mode: 'one', shown: s2!.id });
    expect(byTerminal('sub-2').rect).toMatchObject(dockSlot(lead().rect));
  });

  it('closing the lead turns the sub-terminals into normal windows laid out without overlap', async () => {
    openThree();
    await c.stopAndClose(lead().id);
    expect(listGroups(c.state.windows)).toEqual([]);
    expect(hiddenMembers(c.state.windows).size).toBe(0);
    for (const s of subs()) expect(s.group).toBeNull();
    const inFrame = c.state.windows.filter((w) => w.workspaceId === W.agentdeckLogin);
    for (const a of inFrame) for (const b of inFrame) if (a.id !== b.id) expect(overlaps(a.rect, b.rect)).toBe(false);
  });

  it('the view is saved with the board and restored after a restart', async () => {
    openThree();
    c.selectGroupMember(subs()[2]!.id);
    await c.flush();
    c.dispose();
    c = await boot(api);
    expect(groupView(group())).toEqual({ mode: 'one', shown: byTerminal('sub-3').id });
    expect(hiddenMembers(c.state.windows).size).toBe(2);
  });
});

describe('group sidebar · model', () => {
  const node = (id: string, rect: Rect, group: WindowGroupRef | null, tid: string | null = null): WindowNode => ({
    id: id as WindowId,
    type: 'terminal',
    workspaceId: null,
    rect,
    z: 0,
    title: null,
    restoreRect: null,
    group,
    data: { terminalId: tid },
  });
  const g = 'g1' as never;
  const leadRect = { x: 0, y: 0, w: 400, h: 300 };
  const slot = dockSlot(leadRect);
  const base = () => [
    node('L', leadRect, { id: g, role: 'lead', label: null, view: { mode: 'one', shown: 'A' as WindowId } }),
    node('A', { ...slot, w: 300, h: 200 }, { id: g, role: 'member', label: 'api' }, 'ta'),
    node('B', { x: 900, y: 900, w: 300, h: 200 }, { id: g, role: 'member', label: null }, 'tb'),
  ];

  it('N1 groups without a view count as Show all; names are “sub-n · label”', () => {
    const ws = base();
    const old = ws.map((w) => (w.id === 'L' ? { ...w, group: { id: g, role: 'lead' as const, label: null } } : w));
    expect(groupView(listGroups(old)[0]!)).toEqual({ mode: 'all' });
    expect(hiddenMembers(old).size).toBe(0);
    const grp = listGroups(ws)[0]!;
    expect(grp.members.map((m) => memberName(grp, m))).toEqual(['sub-1 · api', 'sub-2']);
  });

  it('syncGroups parks collapsed members at the slot and moves the docked one with the lead; unchanged → same array', () => {
    const prev = base();
    const parked = syncGroups([], prev, (w) => w.rect);
    expect(parked.find((w) => w.id === 'B')!.rect).toMatchObject(slot);
    expect(syncGroups(parked, parked, (w) => w.rect)).toBe(parked);
    const moved = parked.map((w) => (w.id === 'L' ? { ...w, rect: { ...w.rect, x: 100, y: 50 } } : w));
    const next = syncGroups(parked, moved, (w) => w.rect);
    const slot2 = dockSlot({ ...leadRect, x: 100, y: 50 });
    expect(next.find((w) => w.id === 'A')!.rect).toMatchObject(slot2);
    expect(next.find((w) => w.id === 'B')!.rect).toMatchObject(slot2);
    // 用户把显示的那个拖走了：不再跟着
    const dragged = next.map((w) => (w.id === 'A' ? { ...w, rect: { ...w.rect, x: 2000 } } : w));
    const again = syncGroups(next, dragged.map((w) => (w.id === 'L' ? { ...w, rect: leadRect } : w)), (w) => w.rect);
    expect(again.find((w) => w.id === 'A')!.rect.x).toBe(2000);
  });

  it('lamps: running green, waiting yellow, error red, idle hollow', () => {
    const w = node('A', leadRect, null, 'ta');
    const snap = (status: string) => ({ ta: { terminalId: 'ta', status, since: '', exitCode: null, pending: null } }) as never;
    expect(lampOf(w, snap('running'), {})).toBe('running');
    expect(lampOf(w, snap('needs-approval'), {})).toBe('waiting');
    expect(lampOf(w, snap('needs-reply'), {})).toBe('waiting');
    expect(lampOf(w, snap('error'), {})).toBe('error');
    expect(lampOf(w, snap('idle'), {})).toBe('idle');
    expect(lampOf(w, {}, {})).toBe('idle');
  });
});

describe('group sidebar · Workbench', () => {
  async function mount() {
    const r = registry();
    const a = createFakeApi();
    const ctl = new BoardController({ api: a, registry: r });
    render(<Workbench api={a} controller={ctl} />);
    await waitFor(() => expect(ctl.state.loaded).toBe(true));
    api.dispose();
    c.dispose();
    api = a;
    c = ctl;
  }
  const sidebar = () => document.querySelector<HTMLElement>('.ad-group-sidebar');
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.ad-group-row')];
  const rendered = (tid: string) => !!document.querySelector(`.react-flow__node[data-id="${byTerminal(tid).id}"]`);

  it('lists the sub-terminals with lamps; waiting rows get the attention background', async () => {
    await mount();
    act(() => {
      openThree();
      api.fakes.status.track('sub-1' as TerminalId, { agent: 'claude', workspaceId: W.agentdeckLogin }, 'running');
      api.fakes.status.track('sub-2' as TerminalId, { agent: 'claude', workspaceId: W.agentdeckLogin }, 'running');
      api.fakes.status.requestApproval('sub-2' as TerminalId, { summary: 'Edit src/ui/LoginForm.tsx' });
      api.fakes.status.track('sub-3' as TerminalId, { agent: 'claude', workspaceId: W.agentdeckLogin }, 'idle');
    });
    await waitFor(() => expect(sidebar()).not.toBeNull());
    expect(sidebar()!.querySelector('.ad-group-sidebar-head')!.textContent).toBe('3 subagents');
    expect(rows().map((r) => r.textContent)).toEqual(['sub-1 · api', 'sub-2 · ui', 'sub-3 · tests']);
    await waitFor(() =>
      expect(rows().map((r) => r.querySelector('.ad-group-lamp')!.getAttribute('aria-label'))).toEqual(['Running', 'Waiting', 'Idle']),
    );
    expect(rows().map((r) => r.classList.contains('ad-group-row--waiting'))).toEqual([false, true, false]);
    expect(rows()[0]!.getAttribute('aria-pressed')).toBe('true');
    // 标题栏的灰字
    expect(document.querySelector(`.react-flow__node[data-id="${lead().id}"] .ad-window-label`)!.textContent).toBe('lead');
    expect(document.querySelector(`.react-flow__node[data-id="${subs()[0]!.id}"] .ad-window-label`)!.textContent).toBe('sub-1 · api');
  });

  it('clicking a row switches the visible sub-terminal; Show all / Collapse group', async () => {
    await mount();
    act(() => openThree());
    await waitFor(() => expect(sidebar()).not.toBeNull());
    expect(['sub-1', 'sub-2', 'sub-3'].map(rendered)).toEqual([true, false, false]);
    fireEvent.click(rows()[1]!);
    await waitFor(() => expect(['sub-1', 'sub-2', 'sub-3'].map(rendered)).toEqual([false, true, false]));
    expect(rows()[1]!.getAttribute('aria-pressed')).toBe('true');
    const buttons = [...sidebar()!.querySelectorAll<HTMLButtonElement>('.ad-group-sidebar-actions button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Show all', 'Collapse group']);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(['sub-1', 'sub-2', 'sub-3'].map(rendered)).toEqual([true, true, true]));
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(['sub-1', 'sub-2', 'sub-3'].map(rendered)).toEqual([false, false, false]));
    expect(sidebar()).not.toBeNull();
  });

  it('the sidebar sits right of the lead and goes away when the lead is closed', async () => {
    await mount();
    act(() => openThree());
    await waitFor(() => expect(sidebar()).not.toBeNull());
    const node = sidebar()!.closest<HTMLElement>('.react-flow__node')!;
    const r = sidebarRect(lead().rect);
    expect(node.style.transform).toContain(`translate(${r.x}px,${r.y}px)`);
    await act(() => c.stopAndClose(lead().id));
    await waitFor(() => expect(sidebar()).toBeNull());
    expect(['sub-1', 'sub-2', 'sub-3'].map(rendered)).toEqual([true, true, true]);
  });
});
