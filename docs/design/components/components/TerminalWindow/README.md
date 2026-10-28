# TerminalWindow

TerminalWindow is the content of a terminal window: an xterm.js screen in tmux, plus its zoomed-out summary card, the exit bar, full-pane notices and the in-window Stop-and-close confirm.

**Code:** `packages/ui/widgets/terminal/src/TerminalWindow.tsx`, `terminal.css`; status text in `status.ts`; registered as `type: 'terminal'` (default 560×360, min 110×60, summary below 320×200).

**States**
- **Live:** the screen, padded 4px 8px, on `surface`.
- **Summary card:** the last 3 lines in mono `text-xs`. When waiting, the last line is `attention`. At low zoom it shows a full text snapshot at 13/17px.
- **Exited:** the output is kept, and a bottom bar reads "Process exited (code 1)" with Restart and Close.
- **Notice:** a full-pane mono message for "Connecting…", "Starting claude…", "Previous session ended" (with Restore / Restart) and "Command not found: claude" (with Open Settings / Use Shell instead).
- **Confirm close:** closing a running terminal asks inside the window only, on `scrim`: "Stop claude · Fix the login bug?" with "The current task will be interrupted." (or "claude will exit and this window will close.") and Stop and close.

**Tokens:** `surface`, `line-subtle` bar border, `muted` notices, `attention` waiting line, `scrim` confirm, mono families.

**Interaction**
- Keys go to the shell while the terminal is focused. ⌘-combinations go to the board (⌘K clear, ⌘W close, ⌘Z undo layout).
- The wheel scrolls the scrollback even when the window is not focused.
- localhost links open a browser window on the board.
- **Selecting and copying (IS-143).** When the program doesn't take the mouse (claude, a shell), dragging, double-clicking a word or triple-clicking a line is done by tmux and **copies on release**: the text is on the clipboard and the highlight goes away, no ⌘C needed. When the program takes the mouse (codex), the drag goes to the program; **hold Option and drag** for the terminal's own selection, then ⌘C. The first drag in such a program that selects nothing shows a Toast once per user: "Hold Option to select text".
- ⌘V pastes once, bracketed when the program asked for it.
- **Right-click** (or ⌃-click) the screen: Copy ⌘C · Paste ⌘V · Send selection to ▸ (see ContextMenus). "The selection" is the terminal's own selection, or else the text just copied on release; typing in that terminal or a plain click clears it.
- A running terminal cannot move to another frame: it snaps back and offers "Open new" (W5).
