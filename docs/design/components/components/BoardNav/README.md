# BoardNav

BoardNav is the quick-locate list (MVP v2 · V5) that the side panel shows when nothing is focused: project → workspace (branch) → window, ordered by position on the board. Clicking a row jumps there like ⌘J.

**Code:** `packages/ui/panels/board-nav/src/BoardNav.tsx`, `model.ts` (`buildTree`), `useTopics.ts`, `board-nav.css` (`.bnav*`).

**Props:** `projects`, `workspaces`, `frames`, `windows`, `statuses`, `badges` (straight from board state), `onJump(windowId)`, `api`, `refreshMs` (3000), `headerActions`.

**Rows:** a lamp (or a small window icon for browser windows), the name (mono for terminals), the group role "lead" or "sub-1 · api" in grey, "· Waiting" in `attention` when waiting, and "· Check local git history" (the terminal's conversation title) in `muted`.

**Tokens:** `surface`; header "BOARD" in `eyebrow` style; project 12/600; workspace in mono `muted`; indents `space-md` and `space-2xl`; rows `row` 24, `radius-control`, `hover`; waiting row `attention-soft`.

**Empty states:** "Nothing on the board yet.", "no workspaces", "no windows", and a final group "Not in a workspace".

**Accessibility:** each row is a button named "claude, Running, Check local git history".
