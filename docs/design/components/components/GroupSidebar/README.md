# GroupSidebar

GroupSidebar is the column beside a lead agent (N2, form A) that lists the subagent terminals it opened with `open_terminals`, and, when the lead also has background agents, a read-only BACKGROUND section (N10). Selecting a row shows that subagent docked to the right.

**Code:** `packages/ui/canvas/src/react/GroupSidebar.tsx`, `src/model/groups.ts`, the background rows in `src/react/Background.tsx`, styles in `group-sidebar.css` and `background.css`. Its own React Flow node sits 8px right of the lead, 168 wide and as tall as the lead.

**Content**
- Header: "3 subagents" (or "5 background agents" for a background-only panel).
- Section labels "TERMINALS" and "BACKGROUND · READ-ONLY" (10px, 600, 0.04em, `muted`) when both kinds exist.
- Rows: a lamp, then "sub-2 · ui" (its number and label) or a background task with its elapsed time ("12s"; done shows ✓ and "1m 2s"; failed shows a red time).
- Footer: Show all and Collapse group (ghost, `muted`), or Collapse for a background-only panel.

**Row states**
- **Hover:** `hover`.
- **Selected** (the one shown): `hover` plus 600.
- **Waiting:** `attention-soft` fill. Only subagent terminals can wait.
- **Done:** `muted`.

Lamps are the StatusLamp set: running green, waiting yellow, error red, idle a hollow ring, exited a line.

**Views (`group.view`)**
- `one`: one subagent docked, the rest hidden.
- `all`: tiled as normal windows.
- `collapsed`: the sidebar alone.

Hidden subagents keep running in tmux and still count toward waiting and ⌘J; jumping to one shows it. Closing the lead tiles all subagents and dissolves the group. The title-bar labels read "lead" and "sub-2 · ui".
