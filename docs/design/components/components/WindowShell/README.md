# WindowShell

WindowShell is the frame of every window on the board: a 28px title bar (lamp, mono name, muted label, status, optional tag, hover actions), the content area, eight resize handles, and the focused, waiting, lifted, selected and flash states.

**Code:** `packages/ui/window-shell/src/WindowShell.tsx`, `window-shell.css` (looks and gestures only; it reports screen-pixel deltas and the board converts them by zoom). Used only by `packages/ui/canvas` (`WindowNodeView.tsx`). `TITLE_BAR_HEIGHT` = 28.

**Props:** `name`, `label`, `status` (`WindowStatusBadge`: `text`, `tone`, `dot`, `detail`, `tag`), `focused`, `attention`, `lifted`, `flashKey`, `maximized`, `resizable`, gesture callbacks `onMove*`, `onResize*`, `onTitleDoubleClick`, `onTitleContextMenu`, `onToggleMaximize`, `onClose`.

**Tokens:** `surface`, `line` border, `radius-window`; title bar `line-subtle` bottom border, `text-sm`; name `window-name` mono 500; label and actions `muted`; focused `ink` border + 0.5px outline + `shadow-float`; waiting `status-waiting` border; selected 2px `guide` outline offset 2; tag `line` border, `text-xs` `muted`; action buttons `control-sm`.

**Interaction**
- Drag the title bar to move (3px before it counts as a drag). Edges are 6px, corners 12px, reaching slightly outside the window.
- Double-click the title bar to maximize or restore (⌘⇧↩). Right-click it for the window menu (ContextMenus).
- Maximize and Close appear only on hover or focus.
- An unfocused window carries a cover: the first click only focuses, and the wheel passes through to the content.
- ⌘ or Shift + click on a title bar adds the window to or removes it from the selection.
- The border flashes for 600ms when a window is re-opened or jumped to (⌘J).
- Below 320×200, or under 50% zoom, the content becomes a summary card (see TerminalWindow).

**Must not:** colour the frame for anything but waiting; show focus and waiting borders together (focus wins); put plugin marks inside the frame (they hang outside, see the Plugins cards).
