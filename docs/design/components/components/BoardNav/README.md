# BoardNav

BoardNav is the quick-locate list (MVP v2 · V5) that the side panel shows when nothing is focused. A two-part switch in its header (CO4) picks **Board** (project → workspace (branch) → window) or **Agents** (only agent terminals, grouped by status). Both are ordered by position on the board, and clicking a row jumps there like ⌘J.

**Code:** `packages/ui/panels/board-nav/src/BoardNav.tsx` (the switch and the Board view), `AgentsView.tsx` (the Agents view and its tooltip), `agents.ts` (`buildAgents`, row texts, `agentShortcut`), `lastReply.ts` (the tooltip's reply), `model.ts` (`buildTree`), `useTopics.ts`, `board-nav.css` (`.bnav*`). ⌥⌘1–9 is in `packages/ui/canvas/src/model/shortcuts.ts` and `controller.ts` (`agentOrder`, `jumpToAgentRow`).

**Props:** `projects`, `workspaces`, `frames`, `windows`, `statuses`, `badges` (straight from board state), `onJump(windowId)`, `api`, `refreshMs` (3000), `headerActions`, `lastReply` (the app passes `agentReplyReader(api)`: the session transcript first via `agents.lastReply`, then the screen; without it only the screen is read).

**Switch:** "Board" · "Agents" in `text-xs` inside a `line-subtle` outlined `radius-control` box; the pressed part has a `hover` fill and weight 600 (like a selected row), the other is `muted`. The choice is remembered on this computer (`agentdeck.board-nav.view`); the heading reads "BOARD" or "AGENTS · 6".

**Board rows:** a lamp (or a small window icon for browser windows), the name (mono for terminals), the group role "lead" or "sub-1 · api" in grey, "· Waiting" in `attention` when waiting, and "· Check local git history" (the terminal's conversation title) in `muted`.

**Agents view:** only agent terminals (shells and web pages stay under Board), in fixed groups ERROR · NEEDS YOU · RUNNING · IDLE; each heading is uppercase `text-xs` 600 `muted` with its count ("NEEDS YOU · 2"), and empty groups are not drawn. A row is the same part as on Board: lamp, mono name, `muted` "project · branch", the group role, then on the right "Waiting · 2m" (`attention`, on an `attention-soft` row), "4m" or "1h" (`muted`), "exit 1 · 2m" (`status-error`), "Exited" or "Starting". Below the list, in `muted` `text-xs`: "⌥⌘1–9 jumps to rows 1–9. Shells and web pages are under Board." ⌥⌘1–9 jumps to the first nine Agents rows whichever view the panel shows.

**Last-reply tooltip** (Agents rows; after 350ms on hover, at once on keyboard focus): an `ink` box with `on-ink` text (so it turns light in dark, like Toast), max width 320, `radius-control`, `shadow-float`, `text-sm`, placed to the left of the row. It reads, in order: the title in 600 ("claude · api · feat/pool · Idle · 1h"), a dimmed "Last reply" (or "On screen" when no reply could be recognised and the last lines are shown), the reply (at most 8 lines), and a dimmed "Click to jump · ⌥⌘6". While loading it says "Reading…", with nothing found "Nothing to show yet.", and for an ended session "The session has ended." It closes on leave, click or scroll, and is `role="tooltip"`.

**Tokens:** `surface`; header "BOARD" in `eyebrow` style; project 12/600; workspace in mono `muted`; indents `space-md` and `space-2xl`; rows `row` 24, `radius-control`, `hover`; waiting row `attention-soft`.

**Empty states:** "Nothing on the board yet.", "no workspaces", "no windows", a final group "Not in a workspace", and in Agents "No agents on the board."

**Rules:** colour only on the lamps and on the waiting and error words. The earlier "Unseen" mark and DONE · UNSEEN group were removed on 2026-10-28: the status already shows it.

**Accessibility:** each row is a button named "claude, Running, Check local git history" on Board and "claude, Idle, api · feat/pool" in Agents; the switch is a `group` named "View" with `aria-pressed` buttons.
