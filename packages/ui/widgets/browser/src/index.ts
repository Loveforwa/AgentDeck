// @agentdeck/ui-widget-browser：白板上的网页窗口（线 5 · U1 U2 U3）。
// 组装时注册到白板：registerWindow(browserWindowType)（registerWindow 由 packages/ui/canvas 的注册表提供）。

import type { ComponentType } from 'react';
import type { BrowserWindowData, WindowComponentProps, WindowTypeDefinition } from '@agentdeck/contracts';
import { BrowserWindow } from './BrowserWindow.tsx';

export { BrowserWindow, type BrowserWindowProps } from './BrowserWindow.tsx';
export { browserReuseKey, displayAddress, normalizeAddress } from './address.ts';

export const BROWSER_WINDOW_TYPE = 'browser';

export const browserWindowType: WindowTypeDefinition<
  BrowserWindowData,
  ComponentType<WindowComponentProps<BrowserWindowData>>
> = {
  type: BROWSER_WINDOW_TYPE,
  label: 'Browser',
  defaultSize: { w: 640, h: 420 },
  minSize: { w: 320, h: 200 },
  component: BrowserWindow,
  create: (init) => ({ url: init.url ?? '', mode: init.mode ?? 'frame' }),
};
