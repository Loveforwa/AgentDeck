# ManagerPanel

ManagerPanel is the left manager panel (MP2, board “左边管理面板” MP0, confirmed 2026-10-30). It replaces both the HISTORY sidebar (N11) and the right-hand BoardNav (V5 / CO4): one terminal is one row, whether it is open on the board (with a lamp; click jumps to it) or closed (with a time; click resumes it in its workspace frame). The right panel keeps only source control.

**Code:** `packages/ui/panels/manager/src/ManagerPanel.tsx`, `model.ts` (`buildManager`), `board.ts` (lamps, names, `statusText`, `needsYouOrder`), `ReplyTip.tsx`, `lastReply.ts`, `manager.css` (`.mgr-*`). The shell (`.ad-left-panel`, resizer, saved `BoardState.leftPanel`) is in `packages/ui/canvas`; the New menu is `newMenuItems` in `canvas/src/react/BoardMenu.tsx`; pins are `BoardState.pins` (contracts 0.1.24). apps/desktop wires it in `ManagerSidebar.tsx`.

**Layout, top to bottom**
- **Header:** the board name (14px, 600) and the collapse button. The first top-bar button ("Show sidebar" / "Hide sidebar") opens it; 240–480 wide.
- **New, Search:** two `row`-high rows with a 12px line icon. New opens a menu headed "NEW": Terminal ▸ (installed agents, then Shell), Browser ⌘T, Workspace… ⌘⇧N, Add project… — the same items as right-clicking the board. Search turns into a field; Esc leaves it.
- **NEEDS YOU · n:** only when a terminal waits (yellow) or failed (red); longest wait first; each row adds "project · branch"; waiting rows sit on `attention-soft`. ⌥⌘1–9 jump to rows 1–9 here.
- **PINNED:** a 9px pin and the heading. Pinned sessions, windows, projects (bold, folder icon) and working paths ("shop · feat/login", folder icon), in pin order; drag to reorder. A pinned session that was closed stays as a resumable row.
- **Projects:** the name in bold with ▾/▸ on the right (a count when collapsed) → working paths (▾/▸, branch or folder in mono, "main folder", count) → rows. Each path shows 5 rows (all open ones), then "Show n more". "Not in a workspace" holds open windows outside any frame; "Other folders" (sessions outside any project) starts collapsed.

**A row:** lamp (open only: running green, waiting yellow, error red, idle hollow, exited a short line; a blank 7px when closed) · the agent's 7×7 square with 2px corners (`--agent-*`; Shell and custom commands a hollow square; web pages a 10px window icon) · the title (the rename, else the session title, else the terminal's own title, else the window name) · group role ("lead", "sub-1 · api") in mono · on the right, open rows say status and duration ("Waiting · 2m" in `attention`, "Running · 4m", "Idle · 1h", "exit 1 · 2m" in `status-error`, "Exited"), closed rows a time ("now", "5m", "2h", "3d", "12 Oct"). Hover swaps the time for ⋯.

**Menus (⋯ or right-click):** open rows — Open ↩, Pin / Unpin, Rename…, Copy session id, Close terminal; closed rows — Resume ↩, Pin / Unpin, Fork into… ▸ (greyed for kimi with the reason), Copy session id, Reveal in Finder. Project and working-path headers: Pin / Unpin.

**Hover tip:** on an open agent row after 350 ms (at once on keyboard focus): ink background (`ink` / `on-ink`), max 320 wide, to the right of the row — bold "claude · shop · main · Waiting · 2m", dim "Last reply", the reply (transcript first, else the screen; "On screen" when no reply was recognised), dim "Click to jump · ⌥⌘2" (no shortcut outside NEEDS YOU).

**Rules:** every row appears once — a NEEDS YOU row is not repeated under PINNED or its project, and a pinned row is not repeated under its project. Status colour only on lamps, on the waiting / error words and on the waiting row's background; agent colour only on the square. Empty states: "Couldn’t read the session history.", "Nothing here yet. Use New to start a terminal.", "No matches.", "No workspaces on the board.", "No sessions yet."
