// 后台通知和程序坞角标（S4）：规则在 agent-adapters 的 backgroundAlerts / badgeCount，这里只记状态、调 Electron。
//
// 角标有两个来源：状态机（在等你的终端数）和白板的 app.setBadge（多算了网页窗口自己报的 attention）。
// 规则是“应用在前台时为 0”，所以显示的是：前台 0，后台取两者较大的那个。

import type { StatusSnapshot, TerminalId } from '@agentdeck/contracts';
import { backgroundAlerts, badgeCount, type SystemNotification } from '@agentdeck/agent-adapters';

export interface AlertsDeps {
  appFocused(): boolean;
  notificationsEnabled(): boolean;
  /** 通知标题里怎么称呼这个终端，例如 "claude · agentdeck"。 */
  label(snapshot: StatusSnapshot): string;
  notify(n: SystemNotification): void;
  setDockBadge(count: number): void;
}

export interface Alerts {
  onStatus(snapshot: StatusSnapshot): void;
  /** 白板算的数（app.setBadge）。 */
  setBoardBadge(count: number): void;
  /** 应用切到前台或后台。 */
  focusChanged(): void;
  forget(id: TerminalId): void;
}

export function createAlerts(deps: AlertsDeps): Alerts {
  const all = new Map<TerminalId, StatusSnapshot>();
  let board = 0;
  let shown = -1;

  const refresh = () => {
    const focused = deps.appFocused();
    const n = focused ? 0 : Math.max(board, badgeCount([...all.values()], false));
    if (n !== shown) {
      shown = n;
      deps.setDockBadge(n);
    }
  };

  return {
    onStatus(next) {
      const prev = all.get(next.terminalId) ?? null;
      all.set(next.terminalId, next);
      const out = backgroundAlerts({
        prev,
        next,
        all: [...all.values()],
        appFocused: deps.appFocused(),
        notificationsEnabled: deps.notificationsEnabled(),
        label: deps.label(next),
      });
      if (out.notification) deps.notify(out.notification);
      refresh();
    },
    setBoardBadge(count) {
      board = count;
      refresh();
    },
    focusChanged: refresh,
    forget(id) {
      all.delete(id);
      refresh();
    },
  };
}
