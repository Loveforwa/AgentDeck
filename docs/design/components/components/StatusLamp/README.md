# StatusLamp

StatusLamp is the traffic light (MVP v2 · V2): one coloured dot plus one word, used identically in window title bars, the top bar, frame headers, the group sidebar, BoardNav and history rows.

**Code:** title bar `StatusDot` in `packages/ui/window-shell/src/WindowShell.tsx` (`.ad-window-dot--*`), status text from `packages/ui/widgets/terminal/src/status.ts` (`badgeFor`), list lamps `.ad-group-lamp--*`, `.bnav-lamp--*`, `.hist-lamp--*`, top bar `.ad-topbar-lamp`, frame `.ad-frame-lamp`, background `.ad-bg-lamp--*`.

| State | Lamp | Text | Tokens |
| --- | --- | --- | --- |
| running | filled green dot | "Running · 4m" | `status-running` (dot and text) |
| waiting | filled yellow dot, yellow window border | "Waiting · 2m"; hover "Needs approval" or "Needs reply" | `status-waiting` (dot, border), `attention` (text) |
| error | filled red dot | "Error" or "Error · exit 1" | `status-error` |
| idle | hollow ring | "Idle · now" | `muted` ring 1.5px (1px in lists) |
| starting | hollow ring | "Starting" | `muted` |
| exited | short line 8×2 | "Exited" | `muted` |

**Sizes:** 7px in title bars, frames and lists; 8px in the top bar. A window with no status draws no dot.

**Rules**
- Waiting is the only state that asks for you. It also counts toward the top bar's and frame's "n waiting", ⌘J order and the Dock badge.
- Never colour the word without the dot, and never use these colours for anything that is not a status.
- Times read "now", "4m", "2h", "Oct 21".
