import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Portal } from './portal.tsx';
import './toast.css';

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastOptions {
  /** 一句话，写成事实：“Removed api-server · feat/oauth from the board”。 */
  message: string;
  /** 可选的一个动作，例如 Undo。点了之后提示消失。 */
  action?: ToastAction;
  /** 多久后自动消失（毫秒）。默认 4000，有动作时 6000。鼠标停在上面或焦点在里面时暂停。 */
  duration?: number;
}

export interface ToastApi {
  show(options: ToastOptions): string;
  dismiss(id: string): void;
}

/** 同时最多显示几条，多了丢掉最早的。 */
const MAX_VISIBLE = 3;
export const TOAST_DEFAULT_MS = 4000;
export const TOAST_WITH_ACTION_MS = 6000;

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

/** 同 useToast，但不在 ToastProvider 里时返回 null，不抛错。窗口组件用（单独测试、dev 页面里外面没有 Provider）。 */
export function useOptionalToast(): ToastApi | null {
  return useContext(ToastContext);
}

interface Entry extends ToastOptions {
  id: string;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: string) => setEntries((list) => list.filter((e) => e.id !== id)), []);
  const show = useCallback((options: ToastOptions) => {
    const id = `toast-${++seq.current}`;
    setEntries((list) => [...list, { ...options, id }].slice(-MAX_VISIBLE));
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Portal>
        <div className="ad-toast-viewport" role="region" aria-label="Notifications" aria-live="polite">
          {entries.map((e) => (
            <TimedToast key={e.id} entry={e} onDismiss={() => dismiss(e.id)} />
          ))}
        </div>
      </Portal>
    </ToastContext.Provider>
  );
}

function TimedToast({ entry, onDismiss }: { entry: Entry; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(entry.duration ?? (entry.action ? TOAST_WITH_ACTION_MS : TOAST_DEFAULT_MS));
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const t = setTimeout(() => onDismissRef.current(), remaining.current);
    return () => {
      clearTimeout(t);
      remaining.current -= Date.now() - started;
    };
  }, [paused]);

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Toast
        message={entry.message}
        {...(entry.action
          ? {
              action: {
                label: entry.action.label,
                onAction: () => {
                  entry.action?.onAction();
                  onDismiss();
                },
              },
            }
          : {})}
      />
    </div>
  );
}

/** 一条提示的外观。通常不直接用，用 useToast().show()。 */
export function Toast({ message, action }: { message: string; action?: ToastAction }) {
  return (
    <div className="ad-toast" role="status">
      <span className="ad-toast-message">{message}</span>
      {action && (
        <button type="button" className="ad-toast-action" onClick={action.onAction}>
          {action.label}
        </button>
      )}
    </div>
  );
}
