import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import './menu.css';

export interface MenuItem {
  type?: 'item';
  id: string;
  label: string;
  /** 右侧的快捷键提示，例如 "⌘T"。只是显示，不注册快捷键。 */
  shortcut?: string;
  /** 设了（true 或 false）就是勾选项，左边留出勾的位置。 */
  checked?: boolean;
  disabled?: boolean;
  /** 子菜单。有子菜单的项右边显示 ▸，选中时打开子菜单而不是触发 onSelect。 */
  items?: readonly MenuEntry[];
  onSelect?: () => void;
}

export interface MenuSeparator {
  type: 'separator';
  id?: string;
}

export type MenuEntry = MenuItem | MenuSeparator;

export interface MenuProps {
  items: readonly MenuEntry[];
  /** 任何一个叶子项被选中时调用（在该项自己的 onSelect 之后）。 */
  onSelect?: (item: MenuItem) => void;
  /** 需要关闭整个菜单时调用：选中叶子项、根菜单按 Esc、Tab 移出。 */
  onClose?: () => void;
  'aria-label'?: string;
  /** 打开时把焦点放进菜单。默认 true。 */
  autoFocus?: boolean;
  /** 打开时高亮哪一项：'first'（键盘打开时）或某一项的 id。默认不高亮。 */
  defaultActive?: 'first' | string;
  /** 打开时就展开的子菜单（那一项的 id）。演示和测试用。 */
  defaultOpenSubmenu?: string;
  className?: string;
}

const isItem = (e: MenuEntry): e is MenuItem => e.type !== 'separator';
const enabled = (e: MenuEntry | undefined): e is MenuItem => !!e && isItem(e) && !e.disabled;

function step(items: readonly MenuEntry[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (enabled(items[i])) return i;
  }
  return -1;
}
const first = (items: readonly MenuEntry[]) => step(items, -1, 1);
const last = (items: readonly MenuEntry[]) => step(items, items.length, -1);

/** 菜单面板。自己不负责定位：放进 Popover，或者由调用方摆在某个位置。 */
export function Menu({ className, ...props }: MenuProps) {
  return (
    <MenuList
      {...props}
      className={['ad-menu', className].filter(Boolean).join(' ')}
      level={0}
      closeAll={() => props.onClose?.()}
      closeSelf={() => props.onClose?.()}
    />
  );
}

interface MenuListProps extends Omit<MenuProps, 'className'> {
  className: string;
  level: number;
  /** 关闭整个菜单（选中叶子项之后） */
  closeAll: () => void;
  /** 只关闭这一层：根菜单等于 closeAll；子菜单回到父项 */
  closeSelf: () => void;
}

interface SubmenuState {
  index: number;
  /** 键盘打开的子菜单要把焦点移进去并高亮第一项；鼠标悬停打开的不抢焦点。 */
  focus: boolean;
}

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'Escape']);

function MenuList(props: MenuListProps) {
  const { items, level, closeAll, closeSelf, autoFocus = true, defaultActive, defaultOpenSubmenu } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const baseId = useId();

  const initialActive = (): number => {
    if (defaultActive === 'first') return first(items);
    if (defaultActive) return items.findIndex((e) => isItem(e) && e.id === defaultActive);
    if (defaultOpenSubmenu) return items.findIndex((e) => isItem(e) && e.id === defaultOpenSubmenu);
    return -1;
  };
  const [active, setActive] = useState<number>(initialActive);
  const [submenu, setSubmenu] = useState<SubmenuState | null>(() => {
    const i = defaultOpenSubmenu ? items.findIndex((e) => isItem(e) && e.id === defaultOpenSubmenu) : -1;
    return i >= 0 ? { index: i, focus: false } : null;
  });

  // 焦点跟着高亮项走（roving focus）；没有高亮项时焦点在菜单本身。
  useEffect(() => {
    if (!autoFocus) return;
    const target = active >= 0 ? itemRefs.current[active] : listRef.current;
    target?.focus({ preventScroll: true });
    // 只在打开时做一次；之后焦点由 move() 管。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 子菜单超出窗口右边时翻到左边。
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || level === 0) return;
    const rect = el.getBoundingClientRect();
    const vw = el.ownerDocument.defaultView?.innerWidth ?? 0;
    if (vw > 0 && rect.right > vw) el.classList.add('ad-menu--flip');
  }, [level]);

  const move = (i: number) => {
    setActive(i);
    if (i >= 0) itemRefs.current[i]?.focus({ preventScroll: true });
  };

  const openSubmenu = (i: number, focus: boolean) => {
    setActive(i);
    setSubmenu({ index: i, focus });
    if (!focus) itemRefs.current[i]?.focus({ preventScroll: true });
  };

  const closeSubmenu = () => {
    if (!submenu) return;
    const i = submenu.index;
    setSubmenu(null);
    move(i);
  };

  const activate = (i: number, viaKeyboard: boolean) => {
    const item = items[i];
    if (!enabled(item)) return;
    if (item.items) {
      openSubmenu(i, viaKeyboard);
      return;
    }
    item.onSelect?.();
    props.onSelect?.(item);
    closeAll();
  };

  const typeahead = (ch: string) => {
    const lower = ch.toLowerCase();
    const n = items.length;
    for (let k = 1; k <= n; k++) {
      const i = (active + k + n) % n;
      const e = items[i];
      if (enabled(e) && e.label.toLowerCase().startsWith(lower)) return move(i);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // 子菜单是嵌在父项里面的，按键会冒泡上来；每一层只处理自己的，处理完就停。
    if (e.target !== listRef.current && !itemRefs.current.includes(e.target as HTMLDivElement)) return;
    const key = e.key;
    if (key === 'Tab') {
      closeAll();
      return;
    }
    if (NAV_KEYS.has(key)) {
      e.preventDefault();
      e.stopPropagation();
    }
    switch (key) {
      case 'ArrowDown':
        return move(step(items, active, 1));
      case 'ArrowUp':
        return move(active < 0 ? last(items) : step(items, active, -1));
      case 'Home':
        return move(first(items));
      case 'End':
        return move(last(items));
      case 'ArrowRight': {
        const item = items[active];
        if (enabled(item) && item.items) openSubmenu(active, true);
        return;
      }
      case 'ArrowLeft':
        if (level > 0) closeSelf();
        return;
      case 'Escape':
        return closeSelf();
      case 'Enter':
      case ' ':
        if (active >= 0) activate(active, true);
        return;
      default:
        if (key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && key.trim()) {
          e.preventDefault();
          e.stopPropagation();
          typeahead(key);
        }
    }
  };

  const hasChecks = items.some((e) => isItem(e) && e.checked !== undefined);
  const hasSubmenus = items.some((e) => isItem(e) && e.items);

  return (
    <div
      ref={listRef}
      role="menu"
      aria-label={props['aria-label']}
      aria-orientation="vertical"
      tabIndex={-1}
      className={[props.className, hasChecks && 'ad-menu--checks', hasSubmenus && 'ad-menu--submenus']
        .filter(Boolean)
        .join(' ')}
      onKeyDown={onKeyDown}
    >
      {items.map((entry, i) => {
        if (!isItem(entry)) {
          return <div key={entry.id ?? `sep-${i}`} role="separator" className="ad-menu-separator" />;
        }
        const isActive = i === active;
        const isOpen = submenu?.index === i;
        const role = entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem';
        const onMouseEnter = () => {
          if (entry.disabled) {
            setActive(-1);
            return;
          }
          if (entry.items) {
            if (!isOpen) openSubmenu(i, false);
          } else {
            if (submenu) setSubmenu(null);
            move(i);
          }
        };
        const onClick = (ev: MouseEvent) => {
          ev.stopPropagation();
          activate(i, false);
        };
        // 每一项外面包一层 role="none"：子菜单和父项并列放在里面，父项的可读名称才不会混进子菜单的文字。
        return (
          <div key={entry.id} role="none" className="ad-menu-slot">
            <div
              id={`${baseId}-${entry.id}`}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              role={role}
              aria-checked={entry.checked !== undefined ? entry.checked : undefined}
              aria-disabled={entry.disabled || undefined}
              aria-haspopup={entry.items ? 'menu' : undefined}
              aria-expanded={entry.items ? isOpen : undefined}
              tabIndex={isActive ? 0 : -1}
              data-active={isActive || isOpen || undefined}
              className="ad-menu-item"
              onMouseEnter={onMouseEnter}
              onClick={onClick}
            >
              {hasChecks && <span className="ad-menu-check">{entry.checked && <CheckIcon />}</span>}
              <span className="ad-menu-label">{entry.label}</span>
              {entry.shortcut && <span className="ad-menu-shortcut">{entry.shortcut}</span>}
              {hasSubmenus && <span className="ad-menu-arrow">{entry.items && <ArrowIcon />}</span>}
            </div>
            {isOpen && entry.items && (
              <MenuList
                key={submenu.focus ? 'kbd' : 'mouse'}
                items={entry.items}
                level={level + 1}
                className="ad-menu ad-menu--sub"
                aria-label={entry.label}
                autoFocus={submenu.focus}
                {...(submenu.focus ? { defaultActive: 'first' } : {})}
                {...(props.onSelect ? { onSelect: props.onSelect } : {})}
                closeAll={closeAll}
                closeSelf={closeSubmenu}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 6.2 5 8.6l4.5-5.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 子菜单箭头 ▸ */
function ArrowIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <path d="M2.5 1.5 6 4 2.5 6.5z" fill="currentColor" />
    </svg>
  );
}
