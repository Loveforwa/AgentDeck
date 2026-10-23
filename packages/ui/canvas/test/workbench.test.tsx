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
