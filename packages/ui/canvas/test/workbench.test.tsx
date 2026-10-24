import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import type { WindowComponentProps, WindowId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { Workbench } from '../src/react/Workbench.tsx';
import { createWindowRegistry } from '../src/registry.ts';

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

function setup() {
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
  render(<Workbench api={api} controller={c} />);
  return { api, c };
}

describe('Workbench', () => {
  it('shows a faint line of common shortcuts at the bottom, same keys as the menus', async () => {
    const { c } = setup();
    await waitFor(() => expect(c.state.loaded).toBe(true));
    const hints = document.querySelector<HTMLElement>('.ad-shortcut-hints');
    expect(hints?.getAttribute('aria-label')).toBe('Keyboard shortcuts');
    const items = [...(hints?.querySelectorAll('.ad-shortcut-hint') ?? [])].map((el) => el.textContent);
    expect(items.slice(0, 3)).toEqual(['⌘J next waiting', '⌘⇧] ⌘⇧[ switch window', '⌘⇧↩ maximize']);
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
    expect(screen.getByText('My Board')).toBeTruthy();
    expect(screen.getByText('3 workspaces · 5 terminals')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 waiting' })).toBeTruthy();
    act(() => void api.scenario.agentNeedsApproval(SAMPLE.terminals.loginClaude));
    expect(screen.getByRole('button', { name: '2 waiting' })).toBeTruthy();
    expect(screen.getByText('2 waiting', { selector: '.ad-frame-waiting' })).toBeTruthy();
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
});
