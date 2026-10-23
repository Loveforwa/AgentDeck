// 空白板占位。左下角是一组 IPC 自检，验证 window.agentdeck 的调用、事件、错误还原和终端端口。
// 白板（线 2）接进来后去掉自检。

import { useEffect, useState } from 'react';
import type { TerminalId } from '@agentdeck/contracts';

type CheckState = 'pending' | 'ok' | 'fail';
interface Check {
  label: string;
  state: CheckState;
  detail: string;
}

const LABELS = {
  invoke: 'invoke app.updateSettings (echo)',
  event: 'event app.settings',
  error: 'error restore (projects.list)',
  terminal: 'terminal port echo',
} as const;
type CheckKey = keyof typeof LABELS;

function initialChecks(): Record<CheckKey, Check> {
  const entries = Object.entries(LABELS).map(([key, label]) => [key, { label, state: 'pending', detail: '' }]);
  return Object.fromEntries(entries) as Record<CheckKey, Check>;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const { code } = err as Error & { code?: unknown };
    return `${err.name} ${String(code)}: ${err.message}`;
  }
  return String(err);
}

export function App() {
  const [checks, setChecks] = useState(initialChecks);

  useEffect(() => {
    const api = window.agentdeck;
    const token = `echo-${Date.now()}`;
    let active = true;
    const set = (key: CheckKey, state: CheckState, detail: string) => {
      if (!active) return;
      console.log(`[ipc-check] ${key} ${state} ${detail}`);
      setChecks((prev) => ({ ...prev, [key]: { ...prev[key], state, detail } }));
    };

    const offEvent = api.on('app.settings', (event) => {
      if (event.settings.editorCommand === token) set('event', 'ok', `editorCommand=${token}`);
    });

    api.app.updateSettings({ editorCommand: token }).then(
      (settings) => set('invoke', settings.editorCommand === token ? 'ok' : 'fail', `returned ${settings.editorCommand}`),
      (err: unknown) => set('invoke', 'fail', describe(err)),
    );

    api.projects.list().then(
      () => set('error', 'fail', 'expected an error'),
      (err: unknown) => {
        const { code } = err as { code?: unknown };
        set('error', err instanceof Error && code === 'not-found' ? 'ok' : 'fail', describe(err));
      },
    );

    const text = `hello ${token}`;
    let viewId: string | null = null;
    const offData = api.onTerminalData((message) => {
      if (message.viewId === viewId && message.data === text) set('terminal', 'ok', `${message.viewId}: ${message.data}`);
    });
    api.terminals.attach('echo' as TerminalId, { cols: 80, rows: 24 }).then(
      (view) => {
        viewId = view.viewId;
        api.terminals.write(view.viewId, text);
      },
      (err: unknown) => set('terminal', 'fail', describe(err)),
    );

    return () => {
      active = false;
      offEvent();
      offData();
    };
  }, []);

  return (
    <ul className="ipc-check" aria-label="IPC self-check">
      <li>contracts {window.agentdeck.contractsVersion}</li>
      {Object.entries(checks).map(([key, check]) => (
        <li key={key} data-state={check.state}>
          {check.state} · {check.label} {check.detail && `· ${check.detail}`}
        </li>
      ))}
    </ul>
  );
}
