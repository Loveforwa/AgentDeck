// 工具栏图标：14px 线条，颜色跟随文字（currentColor）。

import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const BackIcon = () => (
  <Icon>
    <path d="M10 3.5 5.5 8 10 12.5" />
  </Icon>
);

export const ForwardIcon = () => (
  <Icon>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Icon>
);

export const ReloadIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.46-3.54" />
    <path d="M13 2.5v3h-3" />
  </Icon>
);

export const ExternalIcon = () => (
  <Icon>
    <path d="M9.5 2.5h4v4" />
    <path d="M13.5 2.5 8 8" />
    <path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
  </Icon>
);
