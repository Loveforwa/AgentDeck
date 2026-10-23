// 线条图标，颜色跟着文字（currentColor）。

import type { SVGProps } from 'react';

function Icon({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const PlusIcon = () => (
  <Icon>
    <path d="M8 3.5v9M3.5 8h9" />
  </Icon>
);

export const MinusIcon = () => (
  <Icon>
    <path d="M3.5 8h9" />
  </Icon>
);

/** 放弃更改：向左回转的箭头。 */
export const DiscardIcon = () => (
  <Icon>
    <path d="M5.5 4 3 6.5 5.5 9" />
    <path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7" />
  </Icon>
);

export const RefreshIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13 2.5v3h-3" />
  </Icon>
);

export const ChevronIcon = ({ open }: { open: boolean }) => (
  <Icon width="10" height="10" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
    <path d="M6 4l4 4-4 4" />
  </Icon>
);

export const CaretIcon = () => (
  <Icon width="10" height="10">
    <path d="M4 6l4 4 4-4" />
  </Icon>
);

export const BranchIcon = () => (
  <Icon width="12" height="12">
    <circle cx="5" cy="3.5" r="1.5" />
    <circle cx="5" cy="12.5" r="1.5" />
    <circle cx="11" cy="5.5" r="1.5" />
    <path d="M5 5v6M11 7c0 2.5-6 1.5-6 4" />
  </Icon>
);

export const BackIcon = () => (
  <Icon>
    <path d="M9.5 4 5.5 8l4 4" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon width="12" height="12">
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </Icon>
);
