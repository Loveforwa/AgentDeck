# SidePanel

SidePanel is the floating right panel shell: 280–480 wide, rounded `radius-panel`, inset from the window edges. It shows source control for the focused window or selected frame, BoardNav when nothing is focused, and collapses to a 28px rail (MVP v2 · V4).

**Code:** `packages/ui/canvas/src/react/Workbench.tsx` (panel, rail, resizer, `renderPanel`), styles in `canvas.css` (`.ad-panel*`). The content packages are `panels/scm` and `panels/board-nav`.

**Tokens:** `surface`, `line` border, `radius-panel`. Margins are 34+2 at the top (clearing the top bar's lamps and gear), 4 on the right and bottom. The resizer is 6px on the left edge. Toggles are `control-sm`, `muted` → `ink`. On the rail, the branch icon is `muted` (at `opacity-disabled` when no workspace is focused) with a 6px `status-waiting` dot for uncommitted changes.

**Interaction**
- ⌘B toggles. The header button reads Collapse panel; the rail button reads Expand panel. Width and open state are saved with the board.
- The panel floats over the board, so the dot grid shows around it. Fit, center and ⌘1 never place content under it.
- The panel follows focus: focused window → its workspace's source control; nothing focused → BoardNav.
