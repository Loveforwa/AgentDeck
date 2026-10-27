# BoardChrome

BoardChrome covers the small fixed pieces around the board: the zoom menu (bottom left), the shortcut hints row (bottom), the empty-board message, and the gestures.

**Code:** `packages/ui/canvas/src/react/Board.tsx`, `ShortcutHints.tsx`, `src/model/shortcuts.ts` (`SHORTCUT_LABELS`), `src/react/gestures.ts`; styles in `canvas.css` (`.ad-board-zoom`, `.ad-shortcut-hints`, `.ad-board-empty`).

**Zoom:** a ghost button showing "40%" in tabular `muted` digits (aria "Zoom"). Its menu opens upward with 25%, 50%, 100%, 200%, then Show all ⌘1. The keys are ⌘0 (100%), ⌘1, ⌘= and ⌘−. The range is 25–200%. Pinch or ⌘ + wheel zooms around the pointer.

**Empty board:** "Add a project to get started, or right-click to open a terminal." with Add project (primary) and New terminal.

**Shortcut hints:** one `text-xs` `muted` row at 75% opacity that ignores the pointer. It reads: "⌘J ⌘⇧J jump to the terminal waiting for you", "⌘⇧] ⌘⇧[ next / previous window by position", "⌘⇧↩ maximize / restore window", "⌘N new terminal", "⌘T new browser window", "⌘B show / hide side panel", "⌘1 fit the whole board", "⌘, settings". Items that do not fit drop from the end. Keys are set in mono.

**Gestures (N6)**
- Two-finger scroll over a window goes to that window; over empty space it pans the board.
- Left or middle drag on empty space pans. Space + drag pans from anywhere, except while typing in a terminal or input.
- Double-click never zooms.
