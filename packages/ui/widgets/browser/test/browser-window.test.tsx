import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindowData, WindowId, WindowNode } from '@agentdeck/contracts';
import { createFakeApi, type FakeApi } from '@agentdeck/fakes';
import { BrowserWindow } from '../src/index.ts';

type Data = BrowserWindowData & { reloadToken?: number };

interface Harness {
  api: FakeApi;
  updateData: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  requestFocus: ReturnType<typeof vi.fn>;
  /** 模拟白板改 data（例如终端里又点了链接）。 */
  boardSets(patch: Partial<Data>): void;
  setFocused(focused: boolean): void;
  frame(): HTMLIFrameElement | null;
  address(): HTMLInputElement;
}

function setup(data: Partial<Data> = {}, options: { focused?: boolean } = {}): Harness {
  const api = createFakeApi({ seed: false });
  window.agentdeck = api;
  const updateData = vi.fn();
  const setStatus = vi.fn();
  const requestFocus = vi.fn();
  let setDataOutside: (patch: Partial<Data>) => void = () => {};
  let setFocusedOutside: (focused: boolean) => void = () => {};

  function Board() {
    const [current, setCurrent] = useState<Data>({ url: '', mode: 'frame', ...data });
    const [focused, setFocused] = useState(options.focused ?? true);
    setDataOutside = (patch) => setCurrent((d) => ({ ...d, ...patch }));
    setFocusedOutside = setFocused;
    const node: WindowNode<Data> = {
      id: 'win-1' as WindowId,
      type: 'browser',
      workspaceId: null,
      rect: { x: 0, y: 0, w: 640, h: 420 },
      z: 0,
      title: null,
      restoreRect: null,
      data: current,
    };
    return (
      <BrowserWindow
        window={node}
        workspace={null}
        focused={focused}
        contentSize={{ w: 640, h: 392 }}
        summary={false}
        visible
        updateData={(patch) => {
          updateData(patch);
          setCurrent((d) => ({ ...d, ...patch }));
        }}
        setStatus={setStatus}
        requestFocus={requestFocus}
        openWindow={() => {}}
        close={() => {}}
        toggleMaximize={() => {}}
        onCommand={() => () => {}}
      />
    );
  }

  render(<Board />);
  return {
    api,
    updateData,
    setStatus,
    requestFocus,
    boardSets: (patch) => act(() => setDataOutside(patch)),
    setFocused: (focused) => act(() => setFocusedOutside(focused)),
    frame: () => document.querySelector('iframe'),
    address: () => screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement,
  };
}

async function loaded(h: Harness): Promise<HTMLIFrameElement> {
  const frame = await waitFor(() => {
    const f = h.frame();
    if (f === null) throw new Error('no iframe yet');
    return f;
  });
  fireEvent.load(frame);
  return frame;
}

function fromFrame(frame: HTMLIFrameElement, data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
  });
}

const location = (href: string, nav: { canGoBack?: boolean; canGoForward?: boolean } = {}) => ({
  source: 'agentdeck-frame',
  type: 'location',
  href,
  title: '',
  canGoBack: nav.canGoBack ?? false,
  canGoForward: nav.canGoForward ?? false,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('opening a page', () => {
  it('prepares the url, shows it in an iframe and clears the loading status on load', async () => {
    const h = setup({ url: 'http://localhost:3000/login' });
    const prepare = vi.spyOn(h.api.browser, 'prepare');
    const frame = await waitFor(() => h.frame() ?? Promise.reject(new Error('no iframe')));
    expect(frame.getAttribute('src')).toBe('http://localhost:3000/login');
    expect(frame.name).toBe('agentdeck-browser:win-1');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(h.setStatus).toHaveBeenLastCalledWith({ text: 'Loading…', tone: 'muted', dot: 'hollow' });
    expect(h.address().value).toBe('localhost:3000/login');
    expect(h.api.fakes.browser.allowedOrigins.has('http://localhost:3000')).toBe(true);

    fireEvent.load(frame);
    expect(h.setStatus).toHaveBeenLastCalledWith(null);
    expect(h.updateData).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled(); // 挂载时只准备了一次，spy 装上之前就完成了
  });

  it('shows the start message without an address', () => {
    setup({ url: '' });
    expect(screen.getByText(/Enter an address above/)).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('opens local files through prepare', async () => {
    const h = setup({ url: '/Users/me/report.html' });
    const frame = await loaded(h);
    expect(frame.getAttribute('src')).toBe('agentdeck-file:///Users/me/report.html');
    expect(h.address().value).toBe('/Users/me/report.html');
  });
});

describe('error page (U3)', () => {
  it('shows “isn’t responding” and Retry when the server is down', async () => {
    const h = setup();
    h.api.fakes.browser.setReachable('http://localhost:3000', false);
    h.boardSets({ url: 'http://localhost:3000/' });
    expect(await screen.findByText('localhost:3000 isn’t responding.')).toBeTruthy();
    expect(screen.getByText('The dev server may not have started yet, or it stopped.')).toBeTruthy();
    expect(h.frame()).toBeNull();
    expect(h.setStatus).toHaveBeenLastCalledWith({ text: 'Not responding', tone: 'error', dot: 'filled' });

    h.api.fakes.browser.setReachable('http://localhost:3000', true);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const frame = await loaded(h);
    expect(frame.hidden).toBe(false);
    expect(screen.queryByText(/isn’t responding/)).toBeNull();
  });

  it('reload checks the server first', async () => {
    const h = setup({ url: 'http://localhost:3000/' });
    await loaded(h);
    h.api.fakes.browser.setReachable('http://localhost:3000', false);
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('localhost:3000 isn’t responding.')).toBeTruthy();
    expect(h.frame()?.hidden).toBe(true);
  });

  it('shows “File not found” with the path for a missing file', async () => {
    const h = setup();
    h.api.fakes.browser.setReachable('/Users/me/gone.html', false, 404);
    h.boardSets({ url: '/Users/me/gone.html' });
    expect(await screen.findByText('File not found')).toBeTruthy();
    expect(screen.getByText('/Users/me/gone.html')).toBeTruthy();
  });

  it('shows the service error for addresses prepare refuses', async () => {
    const h = setup();
    vi.spyOn(h.api.browser, 'prepare').mockRejectedValue(new Error('Only http, https and local files can be opened'));
    h.boardSets({ url: 'http://localhost:3000/' });
    expect(await screen.findByText('Only http, https and local files can be opened')).toBeTruthy();
  });

  it('chrome error page in the frame: refused when the server answers, unreachable when not', async () => {
    const h = setup({ url: 'https://example.com/' });
    let frame = await loaded(h);
    fromFrame(frame, location('chrome-error://chromewebdata/'));
    expect(await screen.findByText('This page can’t be shown on the board.')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Open in browser' }));
    expect(h.api.fakes.browser.opened).toEqual(['https://example.com/']);

    h.boardSets({ url: 'http://localhost:3000/' });
    frame = await loaded(h);
    h.api.fakes.browser.setReachable('http://localhost:3000', false);
    fromFrame(frame, location('chrome-error://chromewebdata/'));
    expect(await screen.findByText('localhost:3000 isn’t responding.')).toBeTruthy();
  });
});

describe('address bar', () => {
  it('edits the full address, opens on Enter and saves it to data.url', async () => {
    const user = userEvent.setup();
    const h = setup({ url: 'http://localhost:3000/' });
    await loaded(h);
    const input = h.address();
    await user.click(input);
    expect(input.value).toBe('http://localhost:3000/');
    await user.clear(input);
    await user.type(input, 'localhost:5173/about{Enter}');
    expect(h.updateData).toHaveBeenLastCalledWith({ url: 'http://localhost:5173/about' });
    const frame = await waitFor(() => {
      const f = h.frame();
      if (f?.getAttribute('src') !== 'http://localhost:5173/about') throw new Error('not yet');
      return f;
    });
    expect(frame).toBeTruthy();
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe('localhost:5173/about');
  });

  it('rejects other schemes and keeps editing', async () => {
    const user = userEvent.setup();
    const h = setup({ url: 'http://localhost:3000/' });
    await loaded(h);
    const input = h.address();
    await user.click(input);
    await user.clear(input);
    await user.type(input, 'javascript:alert(1){Enter}');
    expect(screen.getByRole('alert').textContent).toBe('Only http, https and local file addresses can be opened.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(h.updateData).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it('Esc cancels the edit', async () => {
    const user = userEvent.setup();
    const h = setup({ url: 'http://localhost:3000/' });
    await loaded(h);
    const input = h.address();
    await user.click(input);
    await user.type(input, 'zzz');
    await user.keyboard('{Escape}');
    expect(input.value).toBe('localhost:3000');
    expect(document.activeElement).not.toBe(input);
  });

  it('⌘L focuses the address bar', async () => {
    const h = setup({ url: 'http://localhost:3000/' });
    await loaded(h);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reload' }), { key: 'l', metaKey: true });
    expect(document.activeElement).toBe(h.address());
  });
});

describe('opened again from the terminal (U2)', () => {
  it('navigates when the board changes data.url', async () => {
    const h = setup({ url: 'http://localhost:5173/' });
    await loaded(h);
    const prepare = vi.spyOn(h.api.browser, 'prepare');
    h.boardSets({ url: 'http://localhost:5173/about' });
    await waitFor(() => expect(h.frame()?.getAttribute('src')).toBe('http://localhost:5173/about'));
    expect(prepare).toHaveBeenCalledWith('http://localhost:5173/about');
  });

  it('reloads when the board passes a new reloadToken for the same address', async () => {
    const h = setup({ url: 'http://localhost:5173/' });
    const first = await loaded(h);
    const ping = vi.spyOn(h.api.browser, 'ping');
    h.boardSets({ reloadToken: 1 });
    await waitFor(() => expect(ping).toHaveBeenCalledWith('http://localhost:5173/'));
    // 没有小桥时只能重建 iframe 来刷新
    await waitFor(() => expect(h.frame()).not.toBe(first));
  });

  it('does not navigate again for addresses it wrote itself', async () => {
    const h = setup({ url: 'http://localhost:5173/' });
    const frame = await loaded(h);
    const prepare = vi.spyOn(h.api.browser, 'prepare');
    fromFrame(frame, location('http://localhost:5173/about'));
    expect(h.updateData).toHaveBeenLastCalledWith({ url: 'http://localhost:5173/about' });
    await act(async () => {});
    expect(prepare).not.toHaveBeenCalled();
    expect(h.frame()).toBe(frame);
  });
});

describe('frame bridge', () => {
  it('follows navigation inside the frame and sends back/forward/reload to it', async () => {
    const h = setup({ url: 'http://localhost:3000/' });
    const frame = await loaded(h);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const back = screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);

    fromFrame(frame, location('http://localhost:3000/settings', { canGoBack: true }));
    expect(h.address().value).toBe('localhost:3000/settings');
    expect(back.disabled).toBe(false);

    await userEvent.click(back);
    expect(post).toHaveBeenLastCalledWith({ source: 'agentdeck-board', type: 'back' }, '*');

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith({ source: 'agentdeck-board', type: 'reload' }, '*'));
  });

  it('local files come back as paths', async () => {
    const h = setup({ url: '/Users/me/site/index.html' });
    const frame = await loaded(h);
    fromFrame(frame, location('agentdeck-file:///Users/me/site/about%20us.html'));
    expect(h.updateData).toHaveBeenLastCalledWith({ url: '/Users/me/site/about us.html' });
  });

  it('does not let a web page report a local file or other schemes as its address', async () => {
    const h = setup({ url: 'http://localhost:3000/' });
    const frame = await loaded(h);
    fromFrame(frame, location('agentdeck-file:///Users/me/.ssh/id_rsa'));
    fromFrame(frame, location('about:blank'));
    fromFrame(frame, location('javascript:alert(1)'));
    expect(h.updateData).not.toHaveBeenCalled();
    expect(h.address().value).toBe('localhost:3000');
  });

  it('handles ⌘ shortcuts pressed inside the page', async () => {
    const h = setup({ url: 'http://localhost:3000/' });
    const frame = await loaded(h);
    fromFrame(frame, { source: 'agentdeck-frame', type: 'key', key: 'address' });
    expect(document.activeElement).toBe(h.address());
  });

  it('ignores messages from other windows', async () => {
    const h = setup({ url: 'http://localhost:3000/' });
    await loaded(h);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: location('http://evil.test/'), source: window }));
    });
    expect(h.address().value).toBe('localhost:3000');
    expect(h.updateData).not.toHaveBeenCalled();
  });
});

describe('focus and toolbar', () => {
  it('first click on an unfocused window only focuses it', async () => {
    const h = setup({ url: 'http://localhost:3000/' }, { focused: false });
    await loaded(h);
    const shield = screen.getByTestId('browser-focus-shield');
    fireEvent.pointerDown(shield);
    expect(h.requestFocus).toHaveBeenCalledTimes(1);
    h.setFocused(true);
    expect(screen.queryByTestId('browser-focus-shield')).toBeNull();
  });

  it('back and forward without the bridge walk the addresses opened here', async () => {
    const user = userEvent.setup();
    const h = setup({ url: 'http://localhost:3000/' });
    await loaded(h);
    await user.click(h.address());
    await user.clear(h.address());
    await user.type(h.address(), 'localhost:3000/b{Enter}');
    await waitFor(() => expect(h.frame()?.getAttribute('src')).toBe('http://localhost:3000/b'));

    fireEvent.keyDown(screen.getByRole('button', { name: 'Reload' }), { key: '[', metaKey: true });
    await waitFor(() => expect(h.frame()?.getAttribute('src')).toBe('http://localhost:3000/'));
    expect((screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Forward' }));
    await waitFor(() => expect(h.frame()?.getAttribute('src')).toBe('http://localhost:3000/b'));
  });

  it('Open in browser hands the current address to the system browser', async () => {
    const h = setup({ url: 'http://localhost:3000/x' });
    await loaded(h);
    await userEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(h.api.fakes.browser.opened).toEqual(['http://localhost:3000/x']);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
