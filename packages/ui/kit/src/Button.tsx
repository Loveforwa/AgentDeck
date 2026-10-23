import { forwardRef, type ButtonHTMLAttributes } from 'react';
import './button.css';

export type ButtonVariant = 'default' | 'primary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** default：白底细边；primary：墨色底，一组按钮里最多一个；ghost：无边框，用在工具栏和标题栏。 */
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', type = 'button', className, ...rest },
  ref,
) {
  const cls = ['ad-button', `ad-button--${variant}`, `ad-button--${size}`, className].filter(Boolean).join(' ');
  return <button ref={ref} type={type} className={cls} {...rest} />;
});
