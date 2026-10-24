// 对话框里的小字段：下拉（用 ui-kit 的 Button + Popover + Menu 拼）、文本框、勾选框。ui-kit 里还没有这几个。

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Menu, Popover, type MenuEntry } from '@agentdeck/ui-kit';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** 选项后面淡色的说明，例如“Already on board”。 */
  hint?: string;
}

export function Select(props: {
  value: string | null;
  options: readonly SelectOption[];
  onChange(value: string): void;
  placeholder?: string;
  'aria-label': string;
  /** 菜单最后加的项，例如“Add project…”。 */
  extra?: readonly MenuEntry[];
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const current = props.options.find((o) => o.value === props.value);
  const items: MenuEntry[] = props.options.map((o) => ({
    id: o.value,
    label: o.hint ? `${o.label}  ·  ${o.hint}` : o.label,
    checked: o.value === props.value,
    ...(o.disabled ? { disabled: true } : {}),
    onSelect: () => props.onChange(o.value),
  }));
  if (props.extra?.length) items.push({ type: 'separator' }, ...props.extra);
  return (
    <>
      <Button
        ref={ref}
        size="sm"
        className="ad-select"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props['aria-label']}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ad-select-value">{current?.label ?? props.placeholder ?? 'Choose…'}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
          <path d="M2.5 4 5 6.5 7.5 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      <Popover open={open} anchor={ref} chrome={false} autoFocus={false} onClose={() => setOpen(false)}>
        <Menu items={items} aria-label={props['aria-label']} defaultActive="first" onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ad-field">
      <span className="ad-field-label">{label}</span>
      <div className="ad-field-control">{children}</div>
    </div>
  );
}

export function TextInput(props: {
  value: string;
  onChange(value: string): void;
  'aria-label': string;
  placeholder?: string;
  autoFocus?: boolean;
  onEnter?(): void;
  invalid?: boolean;
}) {
  return (
    <input
      className="ad-input"
      type="text"
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props['aria-label']}
      aria-invalid={props.invalid || undefined}
      spellCheck={false}
      autoComplete="off"
      data-autofocus={props.autoFocus || undefined}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          props.onEnter?.();
        }
      }}
    />
  );
}

export function Checkbox(props: { checked: boolean; onChange(checked: boolean): void; autoFocus?: boolean; children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  // 出现时把焦点放进来：比如删除时才发现有改动，之前按的按钮已经禁用、焦点丢了，Esc 和 Tab 都要能用
  useEffect(() => {
    if (props.autoFocus) ref.current?.focus({ preventScroll: true });
    // 只在出现时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <label className="ad-checkbox" htmlFor={id}>
      <input ref={ref} id={id} type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.children}</span>
    </label>
  );
}

/** 多行文本框，例如 Settings 里一行一个的文件名。 */
export function TextArea(props: { value: string; onChange(value: string): void; 'aria-label': string; placeholder?: string; rows?: number }) {
  return (
    <textarea
      className="ad-input ad-textarea"
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props['aria-label']}
      rows={props.rows ?? 3}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}
