// 终端窗口的 dev 页面：用一个简单的容器代替白板，按 WindowComponentProps 把 props 传给 TerminalWindow。
//
//   pnpm --filter @agentdeck/ui-widget-terminal dev → http://localhost:5340
//     默认：tools/fakes 的 createFakeApi()，回放录好的 claude、pnpm dev，外加已退出、会话没了、摘要卡几种样子
//   http://localhost:5340/?real=1：接真 tmux（先跑 pnpm --filter @agentdeck/tmux-host dev:bridge）
//     窗口列表存在 localStorage，刷新页面 = 重开应用（T6：按 terminalId 接回）

import '@agentdeck/design-tokens/fonts.css';
import '@agentdeck/ui-kit/base.css';
import './dev.css';

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AgentKind,
  AgentSessionId,
  OpenWindowRequest,
  TerminalId,
  TerminalWindowData,
  WindowCommand,
  WindowId,
  WindowNode,
  WindowStatusBadge,
} from '@agentdeck/contracts';
import { createFakeApi, recordings } from '@agentdeck/fakes';
import { Button } from '@agentdeck/ui-kit';
import { TerminalWindow, terminalWindowType } from '../src/index.ts';
import { connectBridge } from './bridge-api.ts';

const REAL = new URLSearchParams(location.search).has('real');
const STORE_KEY = 'agentdeck-terminal-dev-windows';
const TITLE_H = 26;
const CWD = '/Users/me/projects/api-server';

const api = createFakeApi({ seed: false, latencyMs: REAL ? 0 : 30 });
window.agentdeck = api;
// 要在第一次渲染之前换好（终端窗口一挂上就会 list()）
let bridgeStatus = 'connecting…';
const bridgeListeners = new Set<(s: string) => void>();
if (REAL)
  connectBridge(api, (s) => {
    bridgeStatus = s;
    bridgeListeners.forEach((l) => l(s));
  });

interface DevWindow {
  node: WindowNode<TerminalWindowData>;
  visible: boolean;
}

let nextId = 1;
function makeWindow(data: Partial<TerminalWindowData>, size = terminalWindowType.defaultSize): DevWindow {
  return {
    node: {
      id: `dev-term-${nextId++}` as WindowId,
      type: terminalWindowType.type,
      workspaceId: null,
      rect: { x: 0, y: 0, ...size },
      z: 0,
      title: null,
      restoreRect: null,
      data: terminalWindowType.create(data),
    },
    visible: true,
  };
}

/** 假模式的几种样子。 */
function seedFake(): DevWindow[] {
  const t = api.fakes.terminals;
  const claude = t.createWith({ cmd: 'claude', args: [], cwd: CWD }, { id: 'claude-1' as TerminalId, recording: recordings.claudeChat });
  const dev = t.createWith({ cmd: '/bin/zsh', args: ['-lc', 'pnpm dev'], cwd: CWD }, { id: 'zsh-1' as TerminalId, recording: recordings.pnpmDev });
  const codex = t.createWith(
    { cmd: 'codex', args: [], cwd: CWD },
    { id: 'codex-1' as TerminalId, history: '\x1b[1m$ codex\x1b[0m\r\n\x1b[31mError: not logged in\x1b[0m\r\nRun codex login, then try again.\r\n', exited: 1 },
  );
  const small = t.createWith(
    { cmd: 'claude', args: [], cwd: CWD },
    { id: 'claude-2' as TerminalId, history: '› Add rate limiting\r\n  Edit src/limiter.ts\r\n  Bash pnpm test\r\n  18 passed\r\nShould I also add a Redis store?\r\n' },
  );
  api.fakes.status.track(claude, { agent: 'claude', workspaceId: null });
  api.fakes.status.track(small, { agent: 'claude', workspaceId: null });
  return [
    makeWindow({ terminalId: claude, agent: 'claude', cmd: 'claude', cwd: CWD }),
    makeWindow({ terminalId: dev, agent: 'shell', cmd: '/bin/zsh', cwd: CWD, startCommand: 'pnpm dev' }, { w: 480, h: 300 }),
    makeWindow({ terminalId: codex, agent: 'codex', cmd: 'codex', cwd: CWD }, { w: 420, h: 220 }),
    makeWindow({ terminalId: 'gone' as TerminalId, agent: 'claude', cmd: 'claude', cwd: CWD, sessionId: 'session-old' as AgentSessionId }, { w: 420, h: 220 }),
    makeWindow({ terminalId: small, agent: 'claude', cmd: 'claude', cwd: CWD }, { w: 300, h: 150 }),
  ];
}

function loadReal(): DevWindow[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as DevWindow[];
    nextId = saved.length + 1;
    return saved.map((w, i) => ({ ...w, node: { ...w.node, id: `dev-term-${i + 1}` as WindowId } }));
  } catch {
    return [];
  }
}

// 放在模块里只跑一次（StrictMode 会把 useState 的初始化跑两遍）
const INITIAL = REAL ? loadReal() : seedFake();

function App(): ReactNode {
  const [windows, setWindows] = useState<DevWindow[]>(INITIAL);
  const [focusedId, setFocusedId] = useState<WindowId | null>(null);
  const [statuses, setStatuses] = useState<Record<string, WindowStatusBadge | null>>({});
  const [log, setLog] = useState<string[]>([]);
  const [bridge, setBridge] = useState(REAL ? bridgeStatus : '');
  const [home, setHome] = useState(CWD);
  const [command, setCommand] = useState('pnpm dev');
  const commandBus = useRef(new Map<WindowId, Set<(c: WindowCommand) => void>>());

  const note = useCallback((line: string) => setLog((l) => [line, ...l].slice(0, 40)), []);

  useEffect(() => {
    if (!REAL) return;
    bridgeListeners.add(setBridge);
    // 真模式下目录用用户主目录（bridge 会把 '~' 换成 HOME）
    setHome('~');
    return () => {
      bridgeListeners.delete(setBridge);
    };
  }, []);

  useEffect(() => {
    if (REAL) localStorage.setItem(STORE_KEY, JSON.stringify(windows));
  }, [windows]);

  useEffect(() => {
    const offs = [
      api.on('terminal.link', (e) => note(`terminal.link ${e.id} ${e.link.kind === 'localhost' ? e.link.url : `${e.link.path}:${e.link.line ?? ''}`}`)),
      api.on('terminal.exit', (e) => note(`terminal.exit ${e.id} code=${e.code}`)),
      api.on('terminal.host-lost', () => note('terminal.host-lost')),
    ];
    return () => offs.forEach((o) => o());
  }, [note]);

  const patch = useCallback((id: WindowId, change: (w: DevWindow) => DevWindow) => setWindows((ws) => ws.map((w) => (w.node.id === id ? change(w) : w))), []);

  const newTerminal = async (agent: AgentKind, cmd?: string) => {
    try {
      const size = terminalWindowType.termSize!({ w: terminalWindowType.defaultSize.w, h: terminalWindowType.defaultSize.h - TITLE_H });
      const res = await api.agents.start({ agent, cwd: home, workspaceId: null, mode: { kind: 'new' }, size, ...(cmd ? { command: cmd } : {}) });
      const w = makeWindow({ terminalId: res.terminalId, agent, cmd: res.cmd, args: res.args, cwd: home, sessionId: res.sessionId, startCommand: cmd ?? null });
      setWindows((ws) => [...ws, w]);
      setFocusedId(w.node.id);
      note(`agents.start ${agent} → ${res.terminalId}`);
    } catch (e) {
      note(`agents.start failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const close = async (w: DevWindow) => {
    const confirm = terminalWindowType.closeConfirm?.(w.node.data);
    if (confirm && !window.confirm(`${confirm.title}\n\n${confirm.body}`)) return;
    await terminalWindowType.onClose?.(w.node.data);
    setWindows((ws) => ws.filter((x) => x.node.id !== w.node.id));
  };

  const sendCommand = (id: WindowId, c: WindowCommand) => commandBus.current.get(id)?.forEach((l) => l(c));
  const focused = windows.find((w) => w.node.id === focusedId);
  const focusedTerminal = focused?.node.data.terminalId ?? null;

  return (
    <div className="dev">
      <header className="dev-header">
        <span className="dev-title">Terminal window</span>
        <span className="dev-muted">{REAL ? `real tmux · ${bridge}` : 'createFakeApi() — add ?real=1 for real tmux'}</span>
      </header>
      <div className="dev-body">
        <aside className="dev-controls">
          <section>
            <h2>New terminal</h2>
            {(['claude', 'codex', 'shell'] as const).map((a) => (
              <Button key={a} size="sm" onClick={() => void newTerminal(a)}>
                {a}
              </Button>
            ))}
            <div className="dev-row">
              <input value={command} onChange={(e) => setCommand(e.target.value)} aria-label="Command" />
              <Button size="sm" onClick={() => void newTerminal('shell', command)}>
                Run
              </Button>
            </div>
            {REAL && (
              <Button size="sm" onClick={() => void Promise.all([0, 1, 2, 3, 4, 5].map(() => newTerminal('shell')))}>
                6 shells
              </Button>
            )}
          </section>
          <section>
            <h2>Focused window</h2>
            <Button size="sm" disabled={!focused} onClick={() => focused && sendCommand(focused.node.id, 'clear')}>
              Clear (⌘K)
            </Button>
            <Button size="sm" disabled={!focused} onClick={() => focused && sendCommand(focused.node.id, 'restart')}>
              Restart
            </Button>
            <Button size="sm" disabled={!focused} onClick={() => focused && sendCommand(focused.node.id, 'open-in-system-terminal')}>
              Open in system terminal
            </Button>
            {!REAL && (
              <>
                <Button size="sm" disabled={!focusedTerminal} onClick={() => focusedTerminal && api.scenario.agentNeedsApproval(focusedTerminal)}>
                  Agent needs approval
                </Button>
                <Button size="sm" disabled={!focusedTerminal} onClick={() => focusedTerminal && api.scenario.devServerStarts(focusedTerminal)}>
                  Print localhost URL
                </Button>
                <Button size="sm" disabled={!focusedTerminal} onClick={() => focusedTerminal && api.scenario.terminalExits(focusedTerminal, 1)}>
                  Exit with code 1
                </Button>
                <Button size="sm" onClick={() => api.fakes.terminals.hostLost()}>
                  tmux server lost
                </Button>
              </>
            )}
            <Button size="sm" onClick={() => setFocusedId(null)}>
              Blur all
            </Button>
          </section>
          <section>
            <h2>Events</h2>
            <ol className="dev-log">
              {log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ol>
          </section>
        </aside>
        <main className="dev-board" onPointerDown={() => setFocusedId(null)}>
          <div className="dev-grid">
            {windows.map((w) => (
              <DevFrame
                key={w.node.id}
                win={w}
                status={statuses[w.node.id] ?? null}
                focused={focusedId === w.node.id}
                onFocus={() => setFocusedId(w.node.id)}
                onClose={() => void close(w)}
                onResize={(size) => patch(w.node.id, (x) => ({ ...x, node: { ...x.node, rect: { ...x.node.rect, ...size } } }))}
                onToggleVisible={() => patch(w.node.id, (x) => ({ ...x, visible: !x.visible }))}
                onData={(p) => {
                  note(`updateData ${JSON.stringify(p)}`);
                  patch(w.node.id, (x) => ({ ...x, node: { ...x.node, data: { ...x.node.data, ...p } } }));
                }}
                onStatus={(s) => setStatuses((m) => ({ ...m, [w.node.id]: s }))}
                openWindow={(req) => note(`openWindow ${req.type} ${JSON.stringify(req.data)} reuseKey=${req.reuseKey ?? '-'}`)}
                subscribe={(l) => {
                  const set = commandBus.current.get(w.node.id) ?? new Set();
                  set.add(l);
                  commandBus.current.set(w.node.id, set);
                  return () => set.delete(l);
                }}
              />
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}

const SIZES = [
  { label: 'S', w: 300, h: 180 },
  { label: 'M', w: 560, h: 360 },
  { label: 'L', w: 820, h: 520 },
];

function DevFrame(props: {
  win: DevWindow;
  status: WindowStatusBadge | null;
  focused: boolean;
  onFocus(): void;
  onClose(): void;
  onResize(size: { w: number; h: number }): void;
  onToggleVisible(): void;
  onData(p: Partial<TerminalWindowData>): void;
  onStatus(s: WindowStatusBadge | null): void;
  openWindow(req: OpenWindowRequest): void;
  subscribe(l: (c: WindowCommand) => void): () => void;
}): ReactNode {
  const { win, status, focused } = props;
  const { w, h } = win.node.rect;
  const contentSize = useMemo(() => ({ w: w - 2, h: h - TITLE_H - 2 }), [w, h]);
  const summary = w < terminalWindowType.summaryBelow!.w || h < terminalWindowType.summaryBelow!.h;
  return (
    <div
      className="dev-window"
      data-focused={focused}
      data-tone={status?.tone}
      style={{ width: w, height: h }}
      onPointerDown={(e) => {
        e.stopPropagation();
        props.onFocus();
      }}
    >
      <div className="dev-window-title" style={{ height: TITLE_H }}>
        <span className="dev-window-name">{terminalWindowType.title?.(win.node.data)}</span>
        <span className="dev-window-label">{win.node.data.terminalId}</span>
        {status && (
          <span className="dev-status" data-tone={status.tone}>
            {status.text}
          </span>
        )}
        {SIZES.map((s) => (
          <Button key={s.label} variant="ghost" size="sm" onClick={() => props.onResize(s)}>
            {s.label}
          </Button>
        ))}
        <Button variant="ghost" size="sm" onClick={props.onToggleVisible}>
          {win.visible ? 'Hide' : 'Show'}
        </Button>
        <Button variant="ghost" size="sm" aria-label="Close" onClick={props.onClose}>
          ×
        </Button>
      </div>
      <div style={{ width: contentSize.w, height: contentSize.h }}>
        <TerminalWindow
            window={win.node}
            workspace={null}
            focused={focused}
            contentSize={contentSize}
            summary={summary}
            visible={win.visible}
            updateData={props.onData}
            setStatus={props.onStatus}
            requestFocus={props.onFocus}
            openWindow={(req) => props.openWindow(req as OpenWindowRequest)}
            close={props.onClose}
            toggleMaximize={() => {}}
            onCommand={props.subscribe}
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
