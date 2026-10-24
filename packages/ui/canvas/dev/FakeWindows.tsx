// dev 页面用的假窗口：只显示文字，代替线 1 的终端和线 5 的网页。
// 假终端 attach 到 FakeTerminalHost，把输出去掉转义序列后当文字显示，聚焦时按键写回去；
// 状态从 status.snapshot / status.changed 来，用 setStatus 交给标题栏（真终端窗口也会这么做）。

import { useEffect, useRef, useState } from 'react';
import type {
  BrowserWindowData,
  StatusSnapshot,
  TerminalWindowData,
  ViewId,
  WindowComponentProps,
  WindowStatusBadge,
} from '@agentdeck/contracts';
import { registerWindow } from '../src/registry.ts';

const ESC = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** 去掉转义序列，处理 \r 覆盖，返回最后 max 行。 */
function toLines(raw: string, max = 200): string[] {
  const lines = raw.replace(ESC, '').split('\n');
  return lines.map((l) => l.split('\r').filter(Boolean).pop() ?? '').slice(-max);
}

function since(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** 状态 → 标题栏右侧的文字和点（需求「6 · 终端状态与提醒」）。真终端窗口由线 1 做。 */
export function badgeFor(s: StatusSnapshot | null): WindowStatusBadge | null {
  if (!s) return null;
  switch (s.status) {
    case 'starting':
      return { text: 'Starting', tone: 'muted', dot: 'hollow' };
    case 'running':
      return { text: `Running · ${since(s.since)}`, tone: 'running', dot: 'filled' };
    case 'needs-approval':
      return { text: `Waiting · ${since(s.since)}`, tone: 'attention', dot: 'filled', detail: 'Needs approval' };
    case 'needs-reply':
      return { text: `Waiting · ${since(s.since)}`, tone: 'attention', dot: 'filled', detail: 'Needs reply' };
    case 'idle':
      return { text: `Idle · ${since(s.since)}`, tone: 'muted', dot: 'hollow' };
    case 'exited':
      return { text: 'Exited', tone: 'muted', dot: 'none' };
    case 'error':
      return { text: `Error · exit ${s.exitCode ?? 1}`, tone: 'error', dot: 'filled' };
  }
}

function FakeTerminal(props: WindowComponentProps<TerminalWindowData>) {
  const { window: node, focused, summary, visible, setStatus, contentSize, onCommand } = props;
  const id = node.data.terminalId;
  const [text, setText] = useState('');
  const viewRef = useRef<ViewId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 状态
  useEffect(() => {
    if (!id) return;
    const api = window.agentdeck;
    let alive = true;
    let current: StatusSnapshot | null = null;
    const apply = () => setStatus(badgeFor(current));
    void api.status.snapshot().then((all) => {
      if (!alive) return;
      current = all.find((s) => s.terminalId === id) ?? null;
      apply();
    });
    const off = api.on('status.changed', (e) => {
      if (e.snapshot.terminalId !== id) return;
      current = e.snapshot;
      apply();
    });
    const tick = setInterval(apply, 30_000);
    return () => {
      alive = false;
      off();
      clearInterval(tick);
    };
  }, [id, setStatus]);

  // 只为看得见的终端 attach（摘要卡也 attach，假实现里没有 lastLines 的增量）
  useEffect(() => {
    if (!id || !visible) return;
    const api = window.agentdeck;
    let alive = true;
    const offData = api.onTerminalData((m) => {
      if (m.viewId === viewRef.current) setText((t) => (t + m.data).slice(-20000));
    });
    const cols = Math.max(20, Math.floor(contentSize.w / 7.8));
    const rows = Math.max(5, Math.floor(contentSize.h / 17));
    setText('');
    void api.terminals
      .attach(id, { cols, rows })
      .then(({ viewId }) => {
        if (alive) viewRef.current = viewId;
        else void api.terminals.detach(viewId);
      })
      .catch(() => setText('Session ended'));
    return () => {
      alive = false;
      offData();
      if (viewRef.current) void api.terminals.detach(viewRef.current);
      viewRef.current = null;
    };
    // 大小只在 attach 时用；改大小不重新 attach
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, visible]);

  // ⌘K：白板发来的 clear
  useEffect(() => onCommand((command) => command === 'clear' && setText('')), [onCommand]);

  useEffect(() => {
    if (focused) rootRef.current?.focus({ preventScroll: true });
  }, [focused]);

  const lines = toLines(text);
  if (summary) {
    return (
      <div ref={rootRef} className="dev-window dev-window--summary">
        {lines.filter((l) => l.trim()).slice(-3).join('\n') || ' '}
      </div>
    );
  }
  return (
    <div
      ref={rootRef}
      className="dev-window"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.metaKey || !viewRef.current) return;
        const data = e.key === 'Enter' ? '\r' : e.key === 'Backspace' ? '\u007f' : e.key.length === 1 ? e.key : null;
        if (data === null) return;
        e.preventDefault();
        window.agentdeck.terminals.write(viewRef.current, data);
      }}
    >
      {lines.join('\n')}
    </div>
  );
}

function FakeBrowser(props: WindowComponentProps<BrowserWindowData>) {
  const { window: node, summary } = props;
  return (
    <div className="dev-window dev-window--browser">
      <span className="dev-window-url">{node.data.url}</span>
      {summary ? null : <span className="dev-muted">Stand-in for the browser window. The real one is a separate widget.</span>}
    </div>
  );
}

export function registerFakeWindows(): void {
  registerWindow<TerminalWindowData>({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    summaryBelow: { w: 320, h: 200 },
    component: FakeTerminal,
    create: (init) => ({
      terminalId: null,
      agent: 'shell',
      cmd: '/bin/zsh',
      args: [],
      cwd: '~',
      sessionId: null,
      startCommand: null,
      ...init,
    }),
  });
  registerWindow<BrowserWindowData>({
    type: 'browser',
    label: 'Browser',
    defaultSize: { w: 520, h: 360 },
    minSize: { w: 110, h: 60 },
    summaryBelow: { w: 240, h: 160 },
    component: FakeBrowser,
    create: (init) => ({ url: 'http://localhost:3000/', mode: 'frame', ...init }),
  });
}
