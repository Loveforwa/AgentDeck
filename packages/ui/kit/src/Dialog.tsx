import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { focusableIn, rememberFocus } from './focus.ts';
import { Portal } from './portal.tsx';
import './dialog.css';

export interface DialogProps {
  open: boolean;
  /** Esc、取消、（可选）点遮罩时调用。由调用方把 open 设成 false。 */
  onClose: () => void;
  title: ReactNode;
  /** 正文：几句话、单选组、输入框。 */
  children?: ReactNode;
  /** 底部按钮行，从左到右：次要在前，主要在最右。 */
  actions?: ReactNode;
  /** 宽度（px），默认 420。 */
  width?: number;
  /** 打开时聚焦哪个元素。不给就找带 data-autofocus 的，再不然是第一个可聚焦元素。 */
  initialFocus?: RefObject<HTMLElement | null>;
  /** 点遮罩是否关闭。默认 false：桌面应用的确认框不该因为误点消失。 */
  closeOnBackdrop?: boolean;
}

/**
 * 模态对话框。Esc 关闭；打开时焦点移进来，Tab 只在对话框里转；关闭后焦点回到打开前的元素。
 */
export function Dialog({ open, ...rest }: DialogProps) {
  if (!open) return null;
  return (
    <Portal>
      <DialogLayer {...rest} />
    </Portal>
  );
}

function DialogLayer({ onClose, title, children, actions, width, initialFocus, closeOnBackdrop = false }: Omit<DialogProps, 'open'>) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // 在渲染时就记下打开前的焦点：子组件的 effect 比这里的先跑，可能已经把焦点挪走了。
  const restoreFocus = useRef<(() => void) | null>(null);
  if (!restoreFocus.current && typeof document !== 'undefined') restoreFocus.current = rememberFocus(document);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const restore = restoreFocus.current ?? (() => {});
    const target =
      initialFocus?.current ??
      el.querySelector<HTMLElement>('[data-autofocus]') ??
      focusableIn(el.querySelector<HTMLElement>('.ad-dialog-body') ?? el)[0] ??
      focusableIn(el)[0] ??
      el;
    target.focus({ preventScroll: true });
    return restore;
    // 只在打开时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = focusableIn(ref.current);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const firstEl = items[0]!;
    const lastEl = items[items.length - 1]!;
    const active = ref.current.ownerDocument.activeElement;
    if (e.shiftKey && (active === firstEl || active === ref.current)) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && active === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };

  return (
    <div
      className="ad-dialog-backdrop"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="ad-dialog-host"
      >
        <DialogPanel title={title} titleId={titleId} actions={actions} {...(width ? { width } : {})}>
          {children}
        </DialogPanel>
      </div>
    </div>
  );
}

export interface DialogPanelProps {
  title: ReactNode;
  titleId?: string;
  children?: ReactNode;
  actions?: ReactNode;
  width?: number;
}

/** 对话框的外观，不带遮罩和焦点管理。演示页、或者嵌在别处时用。 */
export function DialogPanel({ title, titleId, children, actions, width = 420 }: DialogPanelProps) {
  return (
    <div className="ad-dialog" style={{ width }}>
      <h2 id={titleId} className="ad-dialog-title">
        {title}
      </h2>
      {children !== undefined && <div className="ad-dialog-body">{children}</div>}
      {actions !== undefined && <div className="ad-dialog-actions">{actions}</div>}
    </div>
  );
}

export type DialogTextTone = 'default' | 'muted' | 'attention';

/** 对话框正文里的一段话。attention 只用于需要你注意的风险，比如“3 uncommitted changes will be lost”。 */
export function DialogText({ tone = 'default', children }: { tone?: DialogTextTone; children: ReactNode }) {
  return <p className={`ad-dialog-text ad-dialog-text--${tone}`}>{children}</p>;
}
