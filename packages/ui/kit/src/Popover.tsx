import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { focusableIn, rememberFocus } from './focus.ts';
import { Portal } from './portal.tsx';
import { computePosition, type Placement } from './position.ts';
import './popover.css';

/** 锚点：一个元素、一个 ref，或者一个屏幕坐标（右键菜单）。 */
export type PopoverAnchor = Element | { readonly current: Element | null } | { x: number; y: number } | null;

export interface PopoverProps {
  open: boolean;
  anchor: PopoverAnchor;
  /** 想放在锚点哪一边；放不下会翻到对面。默认 bottom-start。 */
  placement?: Placement;
  /** 和锚点之间的距离，默认 4。 */
  offset?: number;
  /** Esc、点到外面时调用。 */
  onClose?: () => void;
  /** 默认 true：带白底、细边、阴影和内边距。里面放 Menu 时设成 false，由 Menu 自己画外框。 */
  chrome?: boolean;
  /** 打开时把焦点移进去（第一个可聚焦元素，没有就是浮层本身）。默认 true。里面是 Menu 时 Menu 自己管焦点。 */
  autoFocus?: boolean;
  role?: 'dialog' | 'tooltip' | 'presentation';
  'aria-label'?: string;
  className?: string;
  children: ReactNode;
}

function anchorBox(anchor: PopoverAnchor) {
  if (!anchor) return null;
  if ('x' in anchor && 'y' in anchor && !('getBoundingClientRect' in anchor)) {
    return { x: anchor.x, y: anchor.y, width: 0, height: 0 };
  }
  const el = 'current' in anchor ? anchor.current : (anchor as Element);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function anchorElement(anchor: PopoverAnchor): Element | null {
  if (!anchor) return null;
  if ('current' in anchor) return anchor.current;
  return 'getBoundingClientRect' in anchor ? (anchor as Element) : null;
}

export function Popover({ open, ...rest }: PopoverProps) {
  if (!open) return null;
  return (
    <Portal>
      <PopoverLayer {...rest} />
    </Portal>
  );
}

function PopoverLayer({
  anchor,
  placement = 'bottom-start',
  offset = 4,
  onClose,
  chrome = true,
  autoFocus = true,
  role = 'dialog',
  className,
  children,
  ...aria
}: Omit<PopoverProps, 'open'>) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  // 在渲染时就记下打开前的焦点：子组件的 effect 比这里的先跑，可能已经把焦点挪走了。
  const restoreFocus = useRef<(() => void) | null>(null);
  if (!restoreFocus.current && typeof document !== 'undefined') restoreFocus.current = rememberFocus(document);
  onCloseRef.current = onClose;

  const update = useCallback(() => {
    const el = ref.current;
    const box = anchorBox(anchor);
    if (!el || !box) return;
    const win = el.ownerDocument.defaultView ?? window;
    const next = computePosition(
      box,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: win.innerWidth, height: win.innerHeight },
      placement,
      offset,
    );
    // 直接写 DOM，不走 state：位置在绘制前就定好，里面的 Menu 聚焦时浮层已经可见
    // （先隐藏再定位的话，子组件的 focus() 会落空）。
    el.style.left = `${next.x}px`;
    el.style.top = `${next.y}px`;
    el.dataset['placement'] = next.placement;
  }, [anchor, placement, offset]);

  useLayoutEffect(update, [update]);

  useEffect(() => {
    const win = ref.current?.ownerDocument.defaultView ?? window;
    win.addEventListener('resize', update);
    win.addEventListener('scroll', update, true);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (ref.current) ro?.observe(ref.current);
    return () => {
      win.removeEventListener('resize', update);
      win.removeEventListener('scroll', update, true);
      ro?.disconnect();
    };
  }, [update]);

  // 打开时移入焦点，关闭时还给原来的元素（通常是锚点）。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const restore = restoreFocus.current ?? (() => {});
    // 里面的组件（比如 Menu）先跑自己的 effect，焦点已经在里面时就不动。
    if (autoFocus && !el.contains(el.ownerDocument.activeElement)) {
      (focusableIn(el)[0] ?? el).focus({ preventScroll: true });
    }
    return () => {
      // 只有焦点还在浮层里（或已经掉到 body）时才还原，别抢走用户点到别处的焦点。
      const active = el.ownerDocument.activeElement;
      if (!active || active === el.ownerDocument.body || el.contains(active)) restore();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 点到浮层和锚点以外就关闭。
  useEffect(() => {
    const doc = ref.current?.ownerDocument ?? document;
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t)) return;
      if (anchorElement(anchor)?.contains(t)) return;
      onCloseRef.current?.();
    };
    doc.addEventListener('mousedown', onPointerDown, true);
    return () => doc.removeEventListener('mousedown', onPointerDown, true);
  }, [anchor]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCloseRef.current?.();
    }
  };

  return (
    <div
      ref={ref}
      role={role}
      tabIndex={-1}
      aria-label={aria['aria-label']}
      className={['ad-popover', chrome && 'ad-popover--chrome', className].filter(Boolean).join(' ')}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

/** 只有外观、不定位的浮层面板。演示页和需要自己摆位置的地方用。 */
export function PopoverPanel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={['ad-popover-panel', 'ad-popover--chrome', className].filter(Boolean).join(' ')}>{children}</div>;
}
