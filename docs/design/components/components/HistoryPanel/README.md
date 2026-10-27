# HistoryPanel

HistoryPanel is the left HISTORY sidebar (MVP v3 · N11, board 14, IS-86): every agent's past sessions on this machine, grouped by project, then working path (main folder and each worktree), then agent, newest first. Open sessions show their lamp and jump on click; closed ones offer Resume and ⋯. Each agent heading carries that agent's identity colour.

**Code:** `packages/ui/panels/history/src/HistoryPanel.tsx`, `model.ts` (`buildHistory`), `history.css` (`.hist-*`). The shell (`.ad-left-panel`, resizer, saved `BoardState.leftPanel`) is in `packages/ui/canvas` (`Workbench.tsx`, `canvas.css`). apps/desktop wires it in `HistorySidebar.tsx`. Data comes from `window.agentdeck.history.list()`, refreshed every 15 s while open.

**Layout**
- **Toggle and frame:** the first top-bar button ("Show history" / "Hide history") opens and closes it. The sidebar takes its own column 4px in from the window edges, 240–480 wide (drag the right edge), with `radius-panel` and a `line` border. The header reads "HISTORY".
- **Search:** one "Search sessions" field matches title, first message and branch; while searching every path is expanded. There is no agent filter row; the chips were removed on 2026-10-26 and agents are told apart by colour.
- **Project:** the name at 12/600.
- **Working path:** ▾/▸, the branch in mono, and a count. Paths with a frame on the board start expanded. Sessions outside any project go into "Other folders".
- **Agent heading:** a 7×7 square mark with 2px corners, then "CLAUDE · 14" at 10px, 600, 0.04em, both in the agent's colour. Each group shows 5 sessions, then "Show 10 more".
- **Session row:** a lamp only when the session is open on the board (otherwise a blank 7px), the title, and the time ("now", "5m", "2h", "3d", "12 Oct").

**Agent colours:** the heading sets `data-agent`, which maps to `--agent-claude` (terracotta), `--agent-codex` (deep blue), `--agent-pi` (purple), `--agent-omp` (teal) and `--agent-kimi` (blue-grey), with `muted` as the fallback for an unknown agent. The mark is a square on purpose: round dots are status lamps. As text, every agent colour passes 4.5:1 on `surface` and `hover` in both themes.

**Interaction**
- **Open sessions:** click to jump to the terminal and focus it. The hover tooltip lists model, source, start and last activity, folder and branch, the first message, and "On board · Running".
- **Closed sessions:** hover shows Resume and ⋯. The ⋯ menu has Fork into… ▸, Copy session id and Reveal file in Finder. kimi cannot fork, so that item is greyed with the reason. Resume opens a new terminal in that workspace with the agent's own resume arguments, and puts the frame on the board first if needed.
- **Selected row:** the focused terminal's row uses `hover`.

**Empty states:** "Reading sessions…", "Couldn’t read the session history.", "No sessions yet.", "No matching sessions."

**Rules:** status colour appears only on lamps, and agent colour only on the agent heading's mark and text. Everything else stays in the greys.
