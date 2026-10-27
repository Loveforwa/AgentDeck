# WorkspaceFrame

WorkspaceFrame is the rounded box for one workspace (one worktree and branch). Its 36px header carries the project, branch, plugin tags, lamps and the N12 arrange icons; drag the header to move the frame and everything in it.

**Code:** `packages/ui/canvas/src/react/FrameNodeView.tsx` (`FrameNodeView`, `PendingFrameView`, `FrameArrangeButtons`), styles in `canvas.css` (`.ad-frame*`), arrange logic in `src/model/arrange.ts`, data `FrameNode.arrange` (contracts 0.1.10).

**Header (left → right):** project (`body-strong`) · branch (mono `text-sm` `muted`) · workspace name if it differs · plugin tags (Auto-approve) · spacer · "Folder not found" note · "n running" lamp · "n waiting" lamp · arrange icons. When space runs short, the branch truncates first, then the project; lamps never shrink.

**Arrange icons (N12, board 15):** Tidy (compact grid, ⌈√n⌉ columns, sizes unchanged), Columns (up to 6 in a row, same height), Rows (same width), a 1×14 divider, then the Auto-arrange toggle. They are 22×22, `radius-control`, `muted` → `ink` on `hover`. The last-used layout and an enabled Auto-arrange are pressed (`ink` fill, `on-ink` icon). Tooltips: "Tidy · compact grid, sizes unchanged", "Columns · side by side, same height", "Rows · stacked, same width", "Auto-arrange is on · Columns". The icons appear only when the frame has windows.

**States**
- **Default:** 1px `line-strong` border and a 55% `surface` wash.
- **Selected:** 1.5px `ink` outline, offset 2.
- **Drop target:** 1.5px dashed `ink`, shown while a window is dragged in.
- **Pending:** dashed border with "Creating worktree…".
- **Error:** the git message in mono, with "Use existing branch", Retry and Delete.
- **Empty:** "Right-click to add a terminal".

**Interaction**
- Click the header to select. Double-click to fit the frame to its windows. Right-click the header or empty space for the frame menu.
- Resize from 8px edges and 16px corners.
- Frames stay at least 20px apart and push each other. Windows keep a 20px gap and snap within 6px; hold ⌘ to stop snapping.
- A window dragged past the edge grows the frame.
- An arrange is one undo step (⌘Z). Auto-arrange re-runs Tidy, Columns or Rows when a window opens or closes, never mid-drag.
