import { useId, type ReactNode } from 'react';
import './radio.css';

export interface RadioOption<V extends string> {
  value: V;
  label: ReactNode;
  /** 选项下面一行灰字说明。 */
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<V extends string> {
  options: readonly RadioOption<V>[];
  value: V;
  onChange: (value: V) => void;
  name?: string;
  'aria-label'?: string;
}

/** 单选组。用原生 radio，方向键切换、Tab 只停在选中项，都是浏览器自带的行为。 */
export function RadioGroup<V extends string>({ options, value, onChange, name, ...aria }: RadioGroupProps<V>) {
  const autoName = useId();
  const groupName = name ?? autoName;
  return (
    <div role="radiogroup" aria-label={aria['aria-label']} className="ad-radio-group">
      {options.map((o) => (
        <label key={o.value} className="ad-radio" data-disabled={o.disabled || undefined}>
          <input
            type="radio"
            className="ad-radio-input"
            name={groupName}
            value={o.value}
            checked={o.value === value}
            disabled={o.disabled}
            onChange={() => onChange(o.value)}
          />
          <span className="ad-radio-dot" aria-hidden="true" />
          <span className="ad-radio-text">
            <span className="ad-radio-label">{o.label}</span>
            {o.description !== undefined && <span className="ad-radio-description">{o.description}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}
