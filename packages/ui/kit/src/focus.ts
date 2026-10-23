// 焦点相关的小工具：找可聚焦元素、记住并还原焦点。

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true' && !isHiddenRadio(el),
  );
}

// 同一组单选框只有选中的那个参与 Tab 顺序（浏览器的行为），这里照做，焦点陷阱才算得对。
function isHiddenRadio(el: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || el.checked || !el.name) return false;
  const form = el.form ?? el.ownerDocument;
  const group = Array.from(form.querySelectorAll<HTMLInputElement>(`input[type="radio"]`)).filter(
    (r) => r.name === el.name,
  );
  return group.some((r) => r.checked) || group[0] !== el;
}

/** 记下当前焦点，返回一个还原函数。元素已经不在页面上时什么都不做。 */
export function rememberFocus(doc: Document = document): () => void {
  const prev = doc.activeElement as HTMLElement | null;
  return () => {
    if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
  };
}
