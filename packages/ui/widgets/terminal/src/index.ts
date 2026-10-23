// @agentdeck/ui-widget-terminal：白板上的终端窗口（线 1 · T2 T3 T5 T6 T8）。
// 组装时注册到白板：registerTerminalWindow()，或者自己调 registerWindow(terminalWindowType)。

import type { Unsubscribe } from '@agentdeck/contracts';
import { registerWindow } from '@agentdeck/ui-canvas/registry';
import { terminalWindowType } from './definition.ts';

export { terminalWindowType, TERMINAL_MENU, TERMINAL_WINDOW_TYPE, type TerminalWindowDefinition } from './definition.ts';
export { TerminalWindow, OPEN_SETTINGS_EVENT, type TerminalWindowProps } from './TerminalWindow.tsx';
export { TerminalSession, type TerminalSessionOptions } from './session.ts';
export { termSizeFor, FONT_SIZE, CELL_W, CELL_H, PAD_X, PAD_Y } from './metrics.ts';
export { badgeFor, formatSince } from './status.ts';
export { findLinkMatches, findLinks } from './links.ts';
export { commandName } from './title.ts';

/** 往白板的全局注册表里注册终端窗口。返回撤销函数。 */
export function registerTerminalWindow(): Unsubscribe {
  return registerWindow(terminalWindowType);
}
