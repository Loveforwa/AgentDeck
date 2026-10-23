// 网页窗口的 dev 页面：用一个简单的容器代替白板，按 WindowComponentProps 把 props 传给 BrowserWindow。
// 服务用 tools/fakes 的 createFakeApi()；在 Electron 试验窗口里（apps/desktop/src/main/browser/trial/widget.ts）
// 会换成真的 BrowserService（window.agentdeckTrial.browser）。
//
// pnpm --filter @agentdeck/ui-widget-browser dev → http://localhost:5330

import '@agentdeck/design-tokens/fonts.css';
import '@agentdeck/ui-kit/base.css';
import './dev.css';

import { StrictMode, useCallback, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  BrowserService,
  BrowserWindowData,
  OpenWindowRequest,
  WindowId,
  WindowNode,
  WindowStatusBadge,
} from '@agentdeck/contracts';
import { createFakeApi } from '@agentdeck/fakes';
import { Button } from '@agentdeck/ui-kit';
import { BrowserWindow, browserReuseKey, browserWindowType, displayAddress } from '../src/index.ts';

declare global {
  interface Window {
    /** Electron 试验窗口的 preload 放进来的真 BrowserService。 */
    agentdeckTrial?: { browser: BrowserService };
  }
}

const api = createFakeApi({ latencyMs: 60 });
const real = window.agentdeckTrial?.browser;
if (real !== undefined) Object.assign(api, { browser: real });
window.agentdeck = api;

type Data = BrowserWindowData & { reloadToken?: number };

interface DevWindow {
  node: WindowNode<Data>;
  status: WindowStatusBadge | null;
}

const PRESETS: { label: string; url: string }[] = [
  { label: 'localhost:5332', url: 'http://localhost:5332/' },
  { label: 'localhost:5331 (X-Frame-Options)', url: 'http://localhost:5331/' },
  { label: 'localhost:5399 (nothing running)', url: 'http://localhost:5399/' },
  { label: 'UI kit demo :5310', url: 'http://localhost:5310/' },
];

let nextId = 1;
function newWindow(url: string, x: number): DevWindow {
  const data = browserWindowType.create({ url }) as Data;
  return {
    node: {
      id: `dev-browser-${nextId++}` as WindowId,
      type: browserWindowType.type,
      workspaceId: null,
      rect: { x, y: 0, ...browserWindowType.defaultSize },
      z: 0,
      title: null,
      restoreRect: null,
      data,
    },
    status: null,
  };
}

function App(): ReactNode {
  const [windows, setWindows] = useState<DevWindow[]>(() => [newWindow('http://localhost:5332/', 0)]);
  const [focusedId, setFocusedId] = useState<WindowId | null>(null);
  const [zoom, setZoom] = useState(1);
  const [down, setDown] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const note = useCallback((line: string) => setLog((l) => [line, ...l].slice(0, 30)), []);

  const patch = useCallback(
    (id: WindowId, change: (w: DevWindow) => DevWindow) =>
      setWindows((ws) => ws.map((w) => (w.node.id === id ? change(w) : w))),
    [],
  );

  /** 和白板的 openWindow 一样：同类型、同 reuseKey 的窗口开着就聚焦并换地址、刷新（U2），否则新开。 */
  const openWindow = useCallback(
    (req: OpenWindowRequest<Data>) => {
      note(`openWindow ${req.data.url} reuseKey=${req.reuseKey ?? '-'}`);
      const hit = windows.find((w) => req.reuseKey !== undefined && browserReuseKey(w.node.data.url) === req.reuseKey);
      if (hit === undefined) {
        const created = newWindow(req.data.url, windows.length * 40);
        setWindows([...windows, created]);
        setFocusedId(created.node.id);
        return;
      }
      setFocusedId(hit.node.id);
      patch(hit.node.id, (w) => ({
        ...w,
        node: { ...w.node, data: { ...w.node.data, url: req.data.url, reloadToken: Date.now() } },
      }));
    },
    [note, patch, windows],
  );

  const openFromTerminal = (url: string) =>
    openWindow({ type: 'browser', data: { url, mode: 'frame' }, reuseKey: browserReuseKey(url) });

  const toggleDown = () => {
    const next = !down;
    setDown(next);
    // 假服务的 ping；真服务时要自己去停 dev server。
    api.scenario.serverDown('http://localhost:5332/', next);
    note(`fake: localhost:5332 ${next ? 'down' : 'up'}`);
  };

  return (
    <div className="dev">
      <header className="dev-header">
        <span className="dev-title">Browser window</span>
        <span className="dev-muted">{real !== undefined ? 'real BrowserService (Electron)' : 'createFakeApi()'}</span>
      </header>
      <div className="dev-body">
        <aside className="dev-controls">
          <section>
            <h2>Open from terminal (U2)</h2>
            <p className="dev-muted">Same origin already open: focus it and reload.</p>
            {PRESETS.map((p) => (
              <Button key={p.url} size="sm" onClick={() => openFromTerminal(p.url)}>
                {p.label}
              </Button>
            ))}
            <Button size="sm" onClick={() => openFromTerminal('http://localhost:5332/about')}>
              localhost:5332/about
            </Button>
          </section>
          <section>
            <h2>Local file (U3)</h2>
            <input
              className="dev-input"
              placeholder="/absolute/path/to/page.html"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
            />
            <Button size="sm" disabled={!filePath.startsWith('/')} onClick={() => openFromTerminal(filePath)}>
              Open file
            </Button>
          </section>
          <section>
            <h2>Board</h2>
            <label className="dev-row">
              Zoom {Math.round(zoom * 100)}%
              <input type="range" min={0.4} max={1.5} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
            </label>
            <label className="dev-row">
              <input type="checkbox" checked={down} onChange={toggleDown} disabled={real !== undefined} />
              localhost:5332 down (fake ping)
            </label>
            <Button size="sm" onClick={() => setFocusedId(null)}>
              Blur all windows
            </Button>
          </section>
          <section>
            <h2>Calls</h2>
            <ol className="dev-log">
              {log.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ol>
          </section>
        </aside>
        <main className="dev-board" onPointerDown={() => setFocusedId(null)}>
          <div className="dev-layer" style={{ transform: `scale(${zoom})` }}>
            {windows.map((w) => (
              <DevFrame
                key={w.node.id}
                win={w}
                focused={focusedId === w.node.id}
                onFocus={() => setFocusedId(w.node.id)}
                onClose={() => setWindows((ws) => ws.filter((x) => x !== w))}
                onData={(p) => {
                  note(`updateData ${JSON.stringify(p)}`);
                  patch(w.node.id, (x) => ({ ...x, node: { ...x.node, data: { ...x.node.data, ...p } } }));
                }}
                onStatus={(s) => {
                  note(`setStatus ${s === null ? 'null' : s.text}`);
                  patch(w.node.id, (x) => ({ ...x, status: s }));
                }}
                openWindow={openWindow}
              />
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}

function DevFrame(props: {
  win: DevWindow;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onData: (patch: Partial<Data>) => void;
  onStatus: (s: WindowStatusBadge | null) => void;
  openWindow: (req: OpenWindowRequest<Data>) => void;
}): ReactNode {
  const { win, focused, onFocus, onClose, onData, onStatus, openWindow } = props;
  const { w, h } = win.node.rect;
  const titleBar = 28;
  const contentSize = useMemo(() => ({ w, h: h - titleBar }), [w, h]);
  return (
    <div
      className="dev-window"
      data-focused={focused}
      style={{ left: win.node.rect.x, top: win.node.rect.y, width: w, height: h }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onFocus();
      }}
    >
      <div className="dev-window-title" style={{ height: titleBar }}>
        <span>{displayAddress(win.node.data.url) || 'New browser'}</span>
        {win.status !== null && (
          <span className="dev-status" data-tone={win.status.tone}>
            {win.status.text}
          </span>
        )}
        <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose}>
          ×
        </Button>
      </div>
      <div style={{ width: contentSize.w, height: contentSize.h }}>
        <BrowserWindow
          window={win.node}
          workspace={null}
          focused={focused}
          contentSize={contentSize}
          summary={false}
          visible
          updateData={onData}
          setStatus={onStatus}
          requestFocus={onFocus}
          openWindow={(req) => openWindow(req as OpenWindowRequest<Data>)}
          close={onClose}
          toggleMaximize={() => {}}
          onCommand={() => () => {}}
        />
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
