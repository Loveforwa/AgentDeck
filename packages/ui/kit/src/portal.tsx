import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const PortalContext = createContext<HTMLElement | null>(null);

/**
 * 指定 Dialog、Popover、Toast 渲染到哪个元素里，默认是 document.body。
 * 同一页面里有不同 [data-theme] 区域时（比如演示页），在每个区域里放一个，浮层才会用对主题。
 */
export function PortalProvider({ container, children }: { container: HTMLElement | null; children: ReactNode }) {
  return <PortalContext.Provider value={container}>{children}</PortalContext.Provider>;
}

export function Portal({ children }: { children: ReactNode }) {
  const container = useContext(PortalContext);
  const target = container ?? (typeof document === 'undefined' ? null : document.body);
  return target ? createPortal(children, target) : null;
}
