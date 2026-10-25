// PL0 插件入口、PL1 Auto-approve 的界面、X3 Approve all。对着 createFakeApi()。
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuEntry, MenuItem } from '@agentdeck/ui-kit';
import type { ApprovalRecord, PendingRequest, RequestId, TerminalId, TerminalWindowData, WindowComponentProps, WindowId, WorkspaceId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { CONFIRMED_KEY, mergeRecords } from '../src/approvals/model.ts';
import { approvedByText, clockTime, needsYouReasonText } from '../src/approvals/text.ts';
import { BoardController } from '../src/controller.ts';
import { PLUGINS, pluginMenuSection, type PluginDefinition } from '../src/plugins/index.ts';
import { menuItems } from '../src/react/BoardMenu.tsx';
import { Workbench } from '../src/react/Workbench.tsx';
import { createWindowRegistry } from '../src/registry.ts';
import css from '../src/canvas.css?raw';

const T = SAMPLE.terminals;
const W = SAMPLE.workspaces;
const CLAUDE = 'win-login-claude' as WindowId;
const CODEX = 'win-login-codex' as WindowId;

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

beforeEach(() => {
  // 第一次打开时问一句：默认当作已经问过，问的那条用例自己清掉
  localStorage.setItem(CONFIRMED_KEY, '1');
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
  await waitFor(() => expect(c.approvals.state.support).not.toBeNull());
  return { api, c };
}

function windowMenu(c: BoardController, windowId: WindowId): MenuEntry[] {
  return menuItems(c, { screen: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, target: { kind: 'window', windowId } }, { terminal: true, browser: true });
}

function frameMenu(c: BoardController, workspaceId: WorkspaceId): MenuEntry[] {
  return menuItems(c, { screen: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, target: { kind: 'frame-title', workspaceId } }, { terminal: true, browser: true });
}

function item(entries: MenuEntry[], label: string): MenuItem {
  const found = entries.find((e): e is MenuItem => (e.type === undefined || e.type === 'item') && e.label === label);
  if (!found) throw new Error(`no menu item ${label}`);
  return found;
}

const terminalData = (c: BoardController, id: WindowId) => c.windowById(id)!.data as TerminalWindowData;

describe('PL0 plugin entry in the context menus', () => {
  it('a terminal’s title menu lists PLUGINS directly (no submenu), unchecked; a click turns it on and the check follows the service', async () => {
    const { api, c } = await started();
    const items = windowMenu(c, CLAUDE);
    const labels = items.map((i) => (i.type === 'separator' ? '-' : i.label));
    const at = labels.indexOf('PLUGINS');
    expect(labels.slice(at - 1, at + 4)).toEqual(['-', 'PLUGINS', 'Auto-approve', 'Usage', '-']);
    const auto = item(items, 'Auto-approve');
    expect(auto.checked).toBe(false);
    expect(auto.items).toBeUndefined();
    const spy = vi.spyOn(api.approvals, 'setTerminalAutoApprove');
    act(() => auto.onSelect?.());
    await waitFor(() => expect(spy).toHaveBeenCalledWith(T.loginClaude, true));
    await waitFor(() => expect(item(windowMenu(c, CLAUDE), 'Auto-approve').checked).toBe(true));
    // 开关随白板保存：按 approval.auto-approve-changed 写进 TerminalWindowData.autoApprove
    expect(terminalData(c, CLAUDE).autoApprove).toBe(true);
    // 再点一次关掉（框没开着，回到跟着框 = null）
    act(() => item(windowMenu(c, CLAUDE), 'Auto-approve').onSelect?.());
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(T.loginClaude, null));
    await waitFor(() => expect(item(windowMenu(c, CLAUDE), 'Auto-approve').checked).toBe(false));
    expect(terminalData(c, CLAUDE).autoApprove).toBeNull();
    c.dispose();
  });

  it('the first time it asks once before turning on; Cancel leaves it off', async () => {
    localStorage.removeItem(CONFIRMED_KEY);
    const { api, c } = await started();
    const spy = vi.spyOn(api.approvals, 'setTerminalAutoApprove');
    act(() => item(windowMenu(c, CLAUDE), 'Auto-approve').onSelect?.());
    expect(c.approvals.state.confirm).toEqual({ kind: 'terminal', windowId: CLAUDE });
    c.approvals.cancelConfirm();
    expect(spy).not.toHaveBeenCalled();
    act(() => item(windowMenu(c, CLAUDE), 'Auto-approve').onSelect?.());
    c.approvals.confirmTurnOn();
    await waitFor(() => expect(spy).toHaveBeenCalledWith(T.loginClaude, true));
    expect(localStorage.getItem(CONFIRMED_KEY)).toBe('1');
    c.dispose();
  });

  it('unsupported agents are greyed out with the reason; browsers get no PLUGINS section', async () => {
    const { c } = await started();
    const kimi = c.addWindow<Partial<TerminalWindowData>>({
      type: 'terminal',
      workspaceId: W.agentdeckLogin,
      rect: { x: 1300, y: 600, w: 400, h: 300 },
      data: { terminalId: 'term-kimi' as TerminalId, agent: 'kimi', cmd: 'kimi', args: [], cwd: '/tmp' },
    });
    const k = item(windowMenu(c, kimi), 'Auto-approve');
    expect(k.disabled).toBe(true);
    expect(k.hint).toBe('Not supported for kimi yet');
    // IS-68：shell、自定义命令根本没有 Auto-approve 这一项（不是灰掉）；Usage 还在，照常灰掉
    const shellMenu = windowMenu(c, 'win-dev-server' as WindowId);
    const shellLabels = shellMenu.map((i) => (i.type === 'separator' ? '-' : i.label));
    expect(shellLabels).not.toContain('Auto-approve');
    expect(shellLabels).toContain('PLUGINS');
    expect(item(shellMenu, 'Usage')).toMatchObject({ disabled: true, hint: 'Not supported for shell' });
    const custom = c.addWindow<Partial<TerminalWindowData>>({
      type: 'terminal',
      workspaceId: W.agentdeckLogin,
      rect: { x: 1300, y: 1000, w: 400, h: 300 },
      data: { terminalId: 'term-custom' as TerminalId, agent: 'custom', cmd: 'htop', args: [], cwd: '/tmp' },
    });
    expect(windowMenu(c, custom).map((i) => (i.type === 'separator' ? '-' : i.label))).not.toContain('Auto-approve');
    const browser = windowMenu(c, 'win-browser' as WindowId).map((i) => (i.type === 'separator' ? '-' : i.label));
    expect(browser).not.toContain('PLUGINS');
    c.dispose();
  });

  it('the frame menu has the same section with only the plugins that attach to frames, plus Approval history…', async () => {
    const { api, c } = await started();
    const items = frameMenu(c, W.agentdeckLogin);
    const labels = items.map((i) => (i.type === 'separator' ? '-' : i.label));
    const at = labels.indexOf('PLUGINS');
    expect(labels.slice(at, at + 3)).toEqual(['PLUGINS', 'Auto-approve', 'Approval history…']);
    const spy = vi.spyOn(api.approvals, 'setAutoApprove');
    act(() => item(items, 'Auto-approve').onSelect?.());
    await waitFor(() => expect(spy).toHaveBeenCalledWith(W.agentdeckLogin, true));
    await waitFor(() => expect(c.state.frames.find((f) => f.workspaceId === W.agentdeckLogin)?.autoApprove).toBe(true));
    // 框开着：框里的终端都打钩；单独关掉一个只关它自己（false），另一个还开着
    expect(item(windowMenu(c, CLAUDE), 'Auto-approve').checked).toBe(true);
    const own = vi.spyOn(api.approvals, 'setTerminalAutoApprove');
    act(() => item(windowMenu(c, CLAUDE), 'Auto-approve').onSelect?.());
    await waitFor(() => expect(own).toHaveBeenCalledWith(T.loginClaude, false));
    await waitFor(() => expect(item(windowMenu(c, CLAUDE), 'Auto-approve').checked).toBe(false));
    expect(item(windowMenu(c, CODEX), 'Auto-approve').checked).toBe(true);
    expect(terminalData(c, CLAUDE).autoApprove).toBe(false);
    c.dispose();
  });

  it('the registry is the one place to add a plugin: a definition shows up in the right menus only', async () => {
    const { c } = await started();
    const tokens: PluginDefinition = {
      id: 'tokens',
      label: 'Tokens',
      attachesTo: ['terminal'],
      agents: ['claude', 'codex'],
      isOn: () => true,
      toggle: () => {},
    };
    const plugins = [...PLUGINS, tokens];
    const terminal = pluginMenuSection(c, { kind: 'window', windowId: CLAUDE }, plugins).map((e) => (e.type === 'separator' ? '-' : e.label));
    expect(terminal).toEqual(['PLUGINS', 'Auto-approve', 'Usage', 'Tokens']);
    const frame = pluginMenuSection(c, { kind: 'frame', workspaceId: W.agentdeckLogin }, plugins).map((e) => (e.type === 'separator' ? '-' : e.label));
    expect(frame).toEqual(['PLUGINS', 'Auto-approve', 'Approval history…']);
    // 不在 agents 里的终端灰掉
    const shellTokens = pluginMenuSection(c, { kind: 'window', windowId: 'win-shop-shell' as WindowId }, [tokens]);
    expect(shellTokens[1]).toMatchObject({ label: 'Tokens', disabled: true, hint: 'Not supported for shell' });
    c.dispose();
  });
});

describe('PL1 bookmark, frame tag, history', () => {
  function setup() {
    const api = createFakeApi();
    const c = new BoardController({ api, registry: registry() });
    render(<Workbench api={api} controller={c} />);
    return { api, c };
  }
  const node = (id: WindowId) => document.querySelector<HTMLElement>(`[data-window-id="${id}"]`);
  const bookmark = (id: WindowId) => node(id)?.querySelector<HTMLElement>('.ad-auto-approve-mark') ?? null;

  it('hangs a small red “Auto-approve” bookmark from the bottom-left edge only while it is on, outside the content', async () => {
    const { api, c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    expect(bookmark(CLAUDE)).toBeNull();
    await act(() => api.approvals.setTerminalAutoApprove(T.loginClaude, true));
    const b = await waitFor(() => {
      const el = bookmark(CLAUDE);
      if (!el) throw new Error('no bookmark');
      return el;
    });
    expect(b.textContent).toBe('Auto-approve');
    expect(b.dataset.state).toBe('on');
    expect(b.className).toContain('ad-plugin-mark');
    // 在窗口外框外面（节点里、WindowShell 的兄弟），不在内容区里
    expect(b.closest('.ad-window')).toBeNull();
    expect(b.parentElement?.classList.contains('ad-window-node')).toBe(true);
    // 位置：贴着底边外沿、左侧；大小和颜色走 tokens
    const d = declarations('.ad-auto-approve-mark');
    expect(d).toMatch(/position:\s*absolute/);
    expect(d).toMatch(/top:\s*100%/);
    expect(d).toMatch(/left:\s*var\(--space-lg\)/);
    expect(d).toMatch(/height:\s*var\(--plugin-mark-height\)/);
    expect(d).toMatch(/font-size:\s*var\(--plugin-mark-text\)/);
    expect(d).toMatch(/background:\s*var\(--plugin-auto-approve\)/);
    expect(d).toMatch(/border-radius:\s*0 0 var\(--plugin-mark-radius\) var\(--plugin-mark-radius\)/);
    expect(declarations('.ad-window-node')).toMatch(/position:\s*relative/);
    // 别的终端没有
    expect(bookmark(CODEX)).toBeNull();
    await act(() => api.approvals.setTerminalAutoApprove(T.loginClaude, null));
    await waitFor(() => expect(bookmark(CLAUDE)).toBeNull());
  });

  it('turns orange “Needs you” while the service says so, with the reason on hover; back to red when cleared', async () => {
    const { api, c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    await act(() => api.approvals.setTerminalAutoApprove(T.loginClaude, true));
    await waitFor(() => expect(bookmark(CLAUDE)).not.toBeNull());
    let request = null as ReturnType<FakeApi['scenario']['agentNeedsApproval']>;
    act(() => {
      request = api.scenario.agentNeedsApproval(T.loginClaude, { command: 'rm -rf dist' });
      api.bus.emit({ type: 'approval.needs-you', terminalId: T.loginClaude, reason: 'destructive', request });
    });
    expect(request?.destructive).toBe(true);
    await waitFor(() => expect(bookmark(CLAUDE)?.textContent).toBe('Needs you'));
    const b = bookmark(CLAUDE)!;
    expect(b.dataset.state).toBe('needs-you');
    expect(b.className).toContain('ad-auto-approve-mark--needs-you');
    expect(b.title).toBe('Destructive command: rm -rf dist');
    expect(declarations('.ad-auto-approve-mark--needs-you')).toMatch(/background:\s*var\(--attention\)/);
    act(() => api.bus.emit({ type: 'approval.needs-you', terminalId: T.loginClaude, reason: null, request: null }));
    await waitFor(() => expect(bookmark(CLAUDE)?.textContent).toBe('Auto-approve'));
    // 服务还没说处理完、但终端已经不在等了：也变回红色
    act(() => {
      const q = api.scenario.agentAsks(T.loginClaude);
      api.bus.emit({ type: 'approval.needs-you', terminalId: T.loginClaude, reason: 'question', request: q });
    });
    await waitFor(() => expect(bookmark(CLAUDE)?.title).toBe('Question for you: Which database should I use?'));
    act(() => api.scenario.agentTurnEnd(T.loginClaude));
    await waitFor(() => expect(bookmark(CLAUDE)?.textContent).toBe('Auto-approve'));
  });

  it('flashes on each auto-approval; clicking opens the card with since, recent approvals, history and Turn off', async () => {
    const { api, c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    await act(() => api.approvals.setTerminalAutoApprove(T.loginClaude, true));
    await waitFor(() => expect(bookmark(CLAUDE)).not.toBeNull());
    expect(bookmark(CLAUDE)!.querySelector('.ad-auto-approve-flash')).toBeNull();
    act(() => void api.scenario.agentNeedsApproval(T.loginClaude, { command: 'pnpm test auth' }));
    await waitFor(() => expect(bookmark(CLAUDE)!.querySelector('.ad-auto-approve-flash')).not.toBeNull());
    fireEvent.click(bookmark(CLAUDE)!);
    const card = await screen.findByRole('dialog', { name: 'Auto-approve' });
    expect(within(card).getByText(/^since \d\d:\d\d$/)).toBeTruthy();
    await waitFor(() => expect(within(card).getByText('pnpm test auth')).toBeTruthy());
    const spy = vi.spyOn(api.approvals, 'setTerminalAutoApprove');
    fireEvent.click(within(card).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(T.loginClaude, null));
    await waitFor(() => expect(bookmark(CLAUDE)).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Auto-approve' })).toBeNull();
  });

  it('frame on: a red tag in the frame title and bookmarks on every terminal inside', async () => {
    const { api, c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    const frame = () => document.querySelector(`[data-id="frame:${W.agentdeckLogin}"] .ad-frame-header`);
    expect(frame()?.querySelector('.ad-auto-approve-tag')).toBeNull();
    await act(() => api.approvals.setAutoApprove(W.agentdeckLogin, true));
    await waitFor(() => expect(frame()?.querySelector('.ad-auto-approve-tag')?.textContent).toBe('Auto-approve'));
    expect(declarations('.ad-auto-approve-tag')).toMatch(/background:\s*var\(--plugin-auto-approve\)/);
    await waitFor(() => expect(bookmark(CLAUDE)).not.toBeNull());
    expect(bookmark(CODEX)).not.toBeNull();
    // 别的框里的终端没有
    expect(bookmark('win-shop-claude' as WindowId)).toBeNull();
  });

  it('IS-68: frame on only covers the agents inside — shells never get a bookmark, a check or a since', async () => {
    const { api, c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    await waitFor(() => expect(c.approvals.state.support).not.toBeNull());
    const SHOP_SHELL = 'win-shop-shell' as WindowId;
    const SHOP_CLAUDE = 'win-shop-claude' as WindowId;
    const kimi = c.addWindow<Partial<TerminalWindowData>>({
      type: 'terminal',
      workspaceId: W.shopCart,
      rect: { x: 1300, y: 1400, w: 400, h: 300 },
      data: { terminalId: 'term-shop-kimi' as TerminalId, agent: 'kimi', cmd: 'kimi', args: [], cwd: '/tmp' },
    });
    await act(() => api.approvals.setAutoApprove(W.shopCart, true));
    // 服务的开关状态按框算，shell 也在框里
    await waitFor(() => expect(c.approvals.frameOn(W.shopCart)).toBe(true));
    await waitFor(() => expect(bookmark(SHOP_CLAUDE)).not.toBeNull());
    expect(bookmark(SHOP_SHELL)).toBeNull();
    // kimi 是 agent 但不能自动批准：框上开着也不挂书签（菜单里照常灰掉）
    expect(bookmark(kimi)).toBeNull();
    expect(item(windowMenu(c, kimi), 'Auto-approve')).toMatchObject({ disabled: true, checked: false, hint: 'Not supported for kimi yet' });
    const shellNode = c.windowById(SHOP_SHELL)!;
    expect(c.approvals.windowOn(shellNode)).toBe(false);
    expect(c.approvals.since(shellNode)).toBeNull();
    expect(c.approvals.windowOn(c.windowById(kimi)!)).toBe(false);
    expect(c.approvals.since(c.windowById(SHOP_CLAUDE)!)).not.toBeNull();
    // 服务说 shell 在等你（假如它报了）：也不挂 Needs you
    act(() => {
      const request = api.scenario.agentNeedsApproval(T.shopShell, { command: 'rm -rf dist' });
      api.bus.emit({ type: 'approval.needs-you', terminalId: T.shopShell, reason: 'unsupported', request });
    });
    expect(bookmark(SHOP_SHELL)).toBeNull();
    expect(c.approvals.needsYouOf(shellNode)).toBeNull();
    // 单独设置也一样：存着的 true 不让 shell 挂书签
    await act(() => api.approvals.setTerminalAutoApprove(T.shopShell, true).catch(() => undefined));
    expect(bookmark(SHOP_SHELL)).toBeNull();
    expect(windowMenu(c, SHOP_SHELL).map((i) => (i.type === 'separator' ? '-' : i.label))).not.toContain('Auto-approve');
  });

  it('Approval history lists records newest first with terminal, request and who approved', async () => {
    const { api, c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    await act(async () => {
      await api.approvals.approve([api.fakes.status.pending().find((p) => p.terminalId === T.loginCodex)!.id], { by: 'user' });
    });
    await act(() => api.approvals.setTerminalAutoApprove(T.loginClaude, true));
    // 时间不同，新的在前
    await new Promise((r) => setTimeout(r, 5));
    act(() => void api.scenario.agentNeedsApproval(T.loginClaude, { command: 'pnpm lint' }));
    act(() => c.approvals.openHistory({ workspaceId: W.agentdeckLogin }));
    const dialog = await screen.findByRole('dialog', { name: /Approval history · agentdeck · feat\/login/ });
    const rows = await waitFor(() => {
      const r = within(dialog).getAllByRole('row').slice(1);
      if (r.length < 2) throw new Error('not loaded');
      return r;
    });
    expect(rows.map((r) => [...r.querySelectorAll('td')].slice(1).map((td) => td.textContent))).toEqual([
      ['claude', 'pnpm lint', 'Auto-approve'],
      ['codex', 'pnpm test', 'You'],
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(c.approvals.state.history).toBeNull();
  });
});

describe('X3 Approve all', () => {
  it('top bar shows “Approve all…” while something waits for approval; the list leaves destructive ones unchecked', async () => {
    const api = createFakeApi();
    const c = new BoardController({ api, registry: registry() });
    render(<Workbench api={api} controller={c} />);
    await waitFor(() => expect(c.state.loaded).toBe(true));
    // 示例数据里 codex 在等 pnpm test；再来一条破坏性的、一个提问
    act(() => {
      api.scenario.agentNeedsApproval(T.loginClaude, { command: 'git push --force' });
      api.scenario.agentAsks(T.shopClaude);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Approve all…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve these requests?' });
    const boxes = within(dialog).getAllByRole('checkbox') as HTMLInputElement[];
    const rowText = [...dialog.querySelectorAll('.ad-approve-all-row')].map((r) => r.textContent);
    expect(rowText).toEqual([
      'claude · agentdeck · feat/logingit push --forceUnchecked: this looks destructive.',
      'codex · agentdeck · feat/loginpnpm test',
    ]);
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
    expect(within(dialog).getByText('Not included: 1 question waiting for your reply.')).toBeTruthy();

    // codex 没批成（2 秒内状态没变）：那一行标 Couldn’t approve 留给你
    const spy = vi.spyOn(api.approvals, 'approve').mockImplementation(async (ids) => ids.map((id) => ({ id, ok: false as const, reason: 'couldnt-approve' as const })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 1' }));
    await waitFor(() => expect(dialog.querySelector('[data-outcome="couldnt-approve"]')).not.toBeNull());
    const codexId = api.fakes.status.pending().find((p) => p.terminalId === T.loginCodex)!.id;
    expect(spy).toHaveBeenCalledWith([codexId], { by: 'approve-all', includeDestructive: false });
    expect(dialog.querySelector('[data-outcome="couldnt-approve"]')?.textContent).toContain('Couldn’t approve');
    expect(within(dialog).getByRole('button', { name: 'Approve 0' })).toHaveProperty('disabled', true);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();

    // 勾上破坏性的再批：includeDestructive，批成的从列表里去掉
    spy.mockRestore();
    const destructive = (within(dialog).getAllByRole('checkbox') as HTMLInputElement[])[0]!;
    fireEvent.click(destructive);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 1' }));
    await waitFor(() => expect(dialog.querySelectorAll('.ad-approve-all-row')).toHaveLength(1));
    expect(dialog.querySelector('.ad-approve-all-row')?.textContent).toContain('pnpm test');
  });

  it('all approved: closes and says how many still need you', async () => {
    const api = createFakeApi();
    const { c } = await started(api);
    const notes: string[] = [];
    c.setNotify((m) => notes.push(m));
    act(() => api.scenario.agentAsks(T.shopClaude));
    c.approvals.openApproveAll();
    expect(c.approvals.state.approveAll?.rows.map((r) => r.request.terminalId)).toEqual([T.loginCodex]);
    await c.approvals.approveSelected();
    expect(c.approvals.state.approveAll).toBeNull();
    expect(notes).toEqual(['Approved 1 request · 1 still needs you']);
    expect(c.approvals.approvable()).toHaveLength(0);
    c.dispose();
  });
});

describe('restore and helpers', () => {
  it('does not push saved settings again on start (desktop restores), but does when a terminal gets a new terminalId', async () => {
    const api = createFakeApi();
    const board = await api.board.load();
    const claude = board.windows.find((w) => w.id === CLAUDE)!;
    (claude.data as TerminalWindowData).autoApprove = true;
    await api.board.save(board);
    const spy = vi.spyOn(api.approvals, 'setTerminalAutoApprove');
    const { c } = await started(api);
    expect(spy).not.toHaveBeenCalled();
    c.updateData(CLAUDE, { terminalId: 'term-new' as TerminalId });
    expect(spy).toHaveBeenCalledWith('term-new', true);
    c.dispose();
  });

  it('plain-English texts and record merging', () => {
    expect(needsYouReasonText('destructive')).toBe('Destructive command');
    expect(needsYouReasonText('question')).toBe('Question for you');
    expect(needsYouReasonText('couldnt-approve')).toBe('Couldn’t approve');
    expect(needsYouReasonText('unsupported')).toBe('Not supported');
    expect(approvedByText('user')).toBe('You');
    expect(approvedByText('approve-all')).toBe('Approve all');
    expect(approvedByText('auto-approve')).toBe('Auto-approve');
    expect(clockTime(new Date(2026, 9, 25, 9, 5).toISOString())).toBe('09:05');
    const req = { id: 'r1', terminalId: 't', workspaceId: null, agent: 'claude', kind: 'approval', summary: 's', command: null, destructive: false, at: '' } as unknown as PendingRequest;
    const a: ApprovalRecord = { request: { ...req }, by: 'auto-approve', at: '2026-10-25T01:00:00Z' };
    const b: ApprovalRecord = { request: { ...req, id: 'r2' as RequestId }, by: 'user', at: '2026-10-25T02:00:00Z' };
    expect(mergeRecords([a], [b, a]).map((r) => r.request.id)).toEqual(['r2', 'r1']);
  });
});
