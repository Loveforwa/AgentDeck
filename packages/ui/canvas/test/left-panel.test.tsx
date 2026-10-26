// N11：左边栏的外壳——顶栏最左边的按钮开关、收起按钮、宽度 240–480、随白板保存；不给内容时没有左边栏也没有按钮。
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFakeApi, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { Workbench } from '../src/react/Workbench.tsx';
import { createWindowRegistry } from '../src/registry.ts';

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

let api: FakeApi;
let c: BoardController;

afterEach(() => {
  c.dispose();
  api.dispose();
});

async function mount(withLeft: boolean) {
  api = createFakeApi();
  c = new BoardController({ api, registry: createWindowRegistry() });
  render(
    <Workbench
      api={api}
      controller={c}
      {...(withLeft ? { renderLeftPanel: ({ collapseButton }) => <div className="test-history">History {collapseButton}</div> } : {})}
    />,
  );
  await waitFor(() => expect(c.state.loaded).toBe(true));
}

describe('left panel', () => {
  it('is closed by default; the top bar button opens it, its own button closes it, and both are saved', async () => {
    await mount(true);
    expect(document.querySelector('.ad-left-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    await waitFor(() => expect(document.querySelector('.ad-left-panel .test-history')).not.toBeNull());
    expect(c.state.leftPanel).toEqual({ open: true, width: 280 });
    expect(screen.getByRole('button', { name: 'Hide history', pressed: true })).toBeTruthy();

    act(() => c.setLeftPanelWidth(900));
    expect(c.state.leftPanel.width).toBe(480);
    act(() => c.setLeftPanelWidth(10));
    expect(c.state.leftPanel.width).toBe(240);
    await act(async () => {
      await c.flush();
    });
    expect((await api.board.load()).leftPanel).toEqual({ open: true, width: 240 });

    fireEvent.click(document.querySelector<HTMLButtonElement>('.ad-left-panel .ad-panel-toggle')!);
    await waitFor(() => expect(document.querySelector('.ad-left-panel')).toBeNull());
  });

  it('without content there is no left panel and no button', async () => {
    await mount(false);
    expect(screen.queryByRole('button', { name: 'Show history' })).toBeNull();
    act(() => c.toggleLeftPanel());
    expect(document.querySelector('.ad-left-panel')).toBeNull();
  });
});
