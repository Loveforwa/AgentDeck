import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { WindowComponentProps, WindowId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { Workbench, type WorkbenchProps } from '../src/react/Workbench.tsx';
import { createWindowRegistry } from '../src/registry.ts';
import css from '../src/canvas.css?raw';

/** 选择器列表里含 selector 的那几条规则的声明，拼在一起（jsdom 不加载 CSS，直接看源文件）。 */
function declarations(selector: string): string {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2] ?? '');
  }
  return out.join('\n');
}

// jsdom 没有这些，React Flow 要用
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

function Text(props: WindowComponentProps<{ terminalId: string | null }>) {
  return (
    <textarea aria-label={`input ${props.window.id}`} data-summary={props.summary || undefined} defaultValue={props.focused ? 'focused' : ''} />
  );
}

function setup(props: Partial<WorkbenchProps> = {}) {
  const registry = createWindowRegistry();
  registry.register({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    component: Text,
    create: (init: Partial<{ terminalId: string | null }>) => ({ terminalId: null, ...init }),
  });
  const api = createFakeApi();
  const c = new BoardController({ api, registry });
  render(<Workbench api={api} controller={c} {...props} />);
  return { api, c };
}

describe('Workbench', () => {
  it('shows a faint line of common shortcuts at the bottom, same keys as the menus', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    const hints = document.querySelector<HTMLElement>('.ad-shortcut-hints');
    expect(hints?.getAttribute('aria-label')).toBe('Keyboard shortcuts');
    const items = [...(hints?.querySelectorAll('.ad-shortcut-hint') ?? [])].map((el) => el.textContent);
    expect(items.slice(0, 4)).toEqual([
      '⌘J ⌘⇧J jump to the terminal waiting for you',
      '⌘⇧] ⌘⇧[ next / previous window by position',
      '⌘⇧↩ maximize / restore window',
      '⌘N new terminal',
    ]);
  });

  it('closing a running terminal asks inside that window, with the conversation topic; Esc cancels', async () => {
    const { api, c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    api.fakes.terminals.setTitle(SAMPLE.terminals.loginClaude, 'Fix the login bug');
    act(() => c.closeWindow('win-login-claude' as WindowId));
    // React Flow 在 jsdom 里量不到节点大小，节点是 visibility: hidden，所以按选择器找（role 查询会跳过它）
    const confirm = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.ad-window-confirm[role="alertdialog"]');
      if (!el) throw new Error('no confirm yet');
      return el;
    });
    await waitFor(() => expect(confirm.textContent).toContain('· Fix the login bug?'));
    // 只盖住这个窗口：在窗口的节点里面，没有整个应用的遮罩
    expect(confirm.closest('.react-flow__node')?.getAttribute('data-id')).toBe('win-login-claude');
    expect(document.querySelector('.ad-dialog-backdrop')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Stop and close');
    fireEvent.keyDown(confirm, { key: 'Escape' });
    expect(c.state.dialog).toBeNull();
    expect(c.windowById('win-login-claude' as WindowId)).toBeDefined();
  });

  it('shows the top bar counts and the frames', async () => {
    const { api, c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    expect(screen.getByRole('button', { name: 'My Board' })).toBeTruthy();
    expect(screen.getByText('3 workspaces · 6 windows')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 waiting' })).toBeTruthy();
    act(() => void api.scenario.agentNeedsApproval(SAMPLE.terminals.loginClaude));
    expect(screen.getByRole('button', { name: '2 waiting' })).toBeTruthy();
    expect(screen.getByText('2 waiting', { selector: '.ad-frame-waiting' })).toBeTruthy();
  });

  it('frame titles show a green running lamp next to the waiting count; zero counts are hidden (IS-64)', async () => {
    const { api, c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    const frame = (id: string) => {
      const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] .ad-frame-header`);
      if (!el) throw new Error(`no frame ${id}`);
      return el;
    };
    const login = frame(`frame:${SAMPLE.workspaces.agentdeckLogin}`);
    const running = login.querySelector<HTMLElement>('.ad-frame-running');
    expect(running?.textContent).toBe('1 running');
    expect(running?.querySelector('.ad-frame-lamp:not(.ad-frame-lamp--waiting)')?.getAttribute('aria-hidden')).toBe('true');
    expect(login.querySelector('.ad-frame-waiting')?.textContent).toBe('1 waiting');
    expect(login.querySelector('.ad-frame-waiting .ad-frame-lamp--waiting')).toBeTruthy();
    // 顶栏的总数和各框加起来一致
    const total = c.attention().running;
    expect(screen.getByText(`${total} running`, { selector: '.ad-topbar-count--running' })).toBeTruthy();
    const inFrames = [...document.querySelectorAll('.ad-frame-running')].reduce((n, el) => n + parseInt(el.textContent ?? '0', 10), 0);
    expect(inFrames).toBe(total);
    // 没有 running / waiting 的框两个都不显示
    const shop = frame(`frame:${SAMPLE.workspaces.shopCart}`);
    expect(shop.querySelector('.ad-frame-running')).toBeNull();
    expect(shop.querySelector('.ad-frame-waiting')).toBeNull();
    // 状态变了跟着变：login 里的 claude 也去等你了，running 没了
    act(() => void api.scenario.agentNeedsApproval(SAMPLE.terminals.loginClaude));
    expect(frame(`frame:${SAMPLE.workspaces.agentdeckLogin}`).querySelector('.ad-frame-running')).toBeNull();
    expect(frame(`frame:${SAMPLE.workspaces.agentdeckLogin}`).querySelector('.ad-frame-waiting')?.textContent).toBe('2 waiting');
  });

  it('keys typed in a focused terminal are left alone; ⌘ shortcuts are handled', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => c.focusWindow('win-login-claude' as WindowId));
    const input = await screen.findByLabelText('input win-login-claude');
    for (const key of ['Escape', 'Delete', 'y', 'Tab']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(c.state.focusedId).toBe('win-login-claude');
    const open = c.state.panel.open;
    fireEvent.keyDown(input, { key: 'b', metaKey: true });
    expect(c.state.panel.open).toBe(!open);
    fireEvent.keyDown(input, { key: 'j', metaKey: true });
    expect(c.state.focusedId).toBe('win-login-codex');
  });

  it('top bar shows the focused window position among waiting ones; ⌘⇧J and ⌘⇧] are handled', async () => {
    const { api, c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => void api.scenario.agentNeedsApproval(SAMPLE.terminals.loginClaude));
    expect(screen.getByRole('button', { name: '2 waiting' })).toBeTruthy();
    const order = c.attention().waiting;
    act(() => void c.jumpToNextWaiting());
    expect(screen.getByRole('button', { name: '1/2 waiting' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'J', metaKey: true, shiftKey: true });
    expect(c.state.focusedId).toBe(order[1]);
    expect(screen.getByRole('button', { name: '2/2 waiting' })).toBeTruthy();
    act(() => c.focusWindow('win-browser' as WindowId));
    expect(screen.getByRole('button', { name: '2 waiting' })).toBeTruthy();
    fireEvent.keyDown(window, { key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    expect(c.state.focusedId).toBe('win-login-claude');
    // ⌘] 不带 ⇧ 不拦（网页窗口的前进）
    const ev = new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(c.state.focusedId).toBe('win-login-claude');
  });

  it('Esc with nothing focused clears the selection; Delete opens the remove dialog', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => c.selectFrame(SAMPLE.workspaces.shopCart));
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(c.state.dialog?.kind).toBe('remove-workspace');
    expect(await screen.findByText('Delete workspace shop · fix/cart-total')).toBeTruthy();
    expect(screen.getByText('claude will be stopped')).toBeTruthy();
  });

  it('top bar left side follows the focused window: project name and "branch · n windows" (MVP v2 · V1)', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => c.focusWindow('win-login-claude' as WindowId));
    expect(screen.getByRole('button', { name: 'agentdeck' }).getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.getByText('feat/login · 2 windows')).toBeTruthy();
    act(() => c.selectFrame(SAMPLE.workspaces.shopCart));
    expect(screen.getByRole('button', { name: 'shop' })).toBeTruthy();
    expect(screen.getByText('fix/cart-total · 2 windows')).toBeTruthy();
    act(() => c.selectFrame(null));
    expect(screen.getByRole('button', { name: 'My Board' })).toBeTruthy();
    expect(screen.getByText('3 workspaces · 6 windows')).toBeTruthy();
  });

  it('trafficLights leaves room for the macOS window buttons', async () => {
    const { c } = setup({ trafficLights: true });
    await waitFor(() => expect(c.state.loaded).toBe(true));
    expect(document.querySelector('.ad-topbar')?.classList.contains('ad-topbar--traffic-lights')).toBe(true);
  });

  it('the window drag strip sits under the board; windows, frames and the panel are cut out of it (IS-63)', async () => {
    const { c } = setup({ trafficLights: true, renderPanel: () => <div>panel</div> });
    await waitFor(() => expect(c.state.loaded).toBe(true));
    const workbench = document.querySelector('.ad-workbench')!;
    // 拖动条排在最前（DOM 顺序和绘制顺序都在白板、面板之前），顶栏在它后面
    const drag = workbench.firstElementChild!;
    expect(drag.className).toBe('ad-workbench-drag');
    expect(drag.getAttribute('aria-hidden')).toBe('true');
    expect([...workbench.children].map((el) => el.className.split(' ')[0])).toEqual(['ad-workbench-drag', 'ad-topbar', 'ad-workbench-main']);
    const strip = declarations('.ad-workbench-drag');
    expect(strip).toMatch(/-webkit-app-region:\s*drag/);
    expect(strip).toMatch(/height:\s*var\(--topbar-height\)/);
    expect(strip).toMatch(/z-index:\s*0/);
    // 这一条之外 canvas.css 里没有别的 drag
    expect(css.match(/-webkit-app-region:\s*drag/g)).toHaveLength(1);
    for (const selector of ['.ad-board .react-flow__node', '.ad-board .ad-frame-resize', '.ad-board .ad-window-resize', '.ad-panel', '.ad-panel-rail', '.ad-popover', '.ad-dialog']) {
      expect(declarations(selector), selector).toMatch(/-webkit-app-region:\s*no-drag/);
    }
    // 窗口和框都是 React Flow 的节点，面板是 .ad-panel：上面那条规则选得中
    expect(document.querySelector('.ad-board .react-flow__node .ad-frame')).toBeTruthy();
    expect(document.querySelector('.ad-board .react-flow__node .ad-window-node')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Side panel' }).classList.contains('ad-panel')).toBe(true);
  });

  it('the panel collapses to a 28px rail and expands again; ⌘B toggles; the state is saved (MVP v2 · V4)', async () => {
    const { api, c } = setup({
      renderPanel: ({ workspace, collapseButton }) => (
        <div>
          <header>
            <span>Panel for {workspace?.name ?? 'nothing'}</span>
            {collapseButton}
          </header>
        </div>
      ),
    });
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => c.focusWindow('win-login-claude' as WindowId));
    expect(c.state.panel.open).toBe(true);
    expect(screen.getByRole('complementary', { name: 'Side panel' })).toBeTruthy();
    expect(screen.getByText(/Panel for/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }));
    expect(c.state.panel.open).toBe(false);
    expect(screen.queryByText(/Panel for/)).toBeNull();
    const rail = screen.getByRole('complementary', { name: 'Side panel (collapsed)' });
    expect(rail.classList.contains('ad-panel-rail')).toBe(true);
    // feat/login 有未提交的改动：分支图标旁一个点
    expect(await within(rail).findByRole('img', { name: 'Uncommitted changes' })).toBeTruthy();

    // 保存的布局里 panel.open 为 false
    const save = vi.spyOn(api.board, 'save');
    await act(() => c.flush());
    expect(save.mock.calls.at(-1)?.[0].panel.open).toBe(false);

    fireEvent.click(within(rail).getByRole('button', { name: 'Expand panel' }));
    expect(c.state.panel.open).toBe(true);
    expect(screen.getByText(/Panel for/)).toBeTruthy();

    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(c.state.panel.open).toBe(false);
    expect(screen.getByRole('button', { name: 'Expand panel' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(screen.getByRole('button', { name: 'Collapse panel' })).toBeTruthy();
  });

  it('the rail dot follows git.status: none for a clean workspace, appears when files change', async () => {
    const { api, c } = setup({ renderPanel: () => <div>panel</div> });
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => c.focusWindow('win-dev-server' as WindowId));
    act(() => c.togglePanel());
    const rail = screen.getByRole('complementary', { name: 'Side panel (collapsed)' });
    expect(rail.querySelector('.ad-panel-rail-branch')?.getAttribute('title')).toBe('main');
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(within(rail).queryByRole('img', { name: 'Uncommitted changes' })).toBeNull();
    act(() => api.scenario.gitChanged(SAMPLE.paths.agentdeck, [{ path: 'README.md', unstaged: 'modified' }]));
    expect(await within(rail).findByRole('img', { name: 'Uncommitted changes' })).toBeTruthy();
  });

  it('the rail shows the branch icon even with nothing in focus, muted and without a dot (IS-67)', async () => {
    const { api, c } = setup({ renderPanel: () => <div>panel</div> });
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => c.togglePanel());
    expect(c.activeWorkspaceId(c.state)).toBeNull();
    const rail = screen.getByRole('complementary', { name: 'Side panel (collapsed)' });
    const branch = rail.querySelector('.ad-panel-rail-branch');
    expect(branch?.querySelector('svg')).toBeTruthy();
    expect(branch?.classList.contains('ad-panel-rail-branch--idle')).toBe(true);
    expect(branch?.getAttribute('title')).toBe('No workspace in focus');
    // 有未提交改动的仓库也不出点：点只跟着聚焦的工作区
    act(() => api.scenario.gitChanged(SAMPLE.paths.agentdeck, [{ path: 'README.md', unstaged: 'modified' }]));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(within(rail).queryByRole('img', { name: 'Uncommitted changes' })).toBeNull();

    // 聚焦一个窗口：图标变回正常，标题是分支名
    act(() => c.focusWindow('win-login-claude' as WindowId));
    const focused = screen.getByRole('complementary', { name: 'Side panel (collapsed)' }).querySelector('.ad-panel-rail-branch');
    expect(focused?.classList.contains('ad-panel-rail-branch--idle')).toBe(false);
    expect(await within(rail).findByRole('img', { name: 'Uncommitted changes' })).toBeTruthy();
  });

  it('without renderPanel there is neither a panel nor a rail', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    act(() => c.togglePanel());
    expect(screen.queryByRole('complementary', { name: /Side panel/ })).toBeNull();
  });
});
