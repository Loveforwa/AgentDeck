# ScmPanel

ScmPanel is the source-control panel, modelled on VS Code. It shows the workspace head and path, the branch picker with ahead/behind, the commit box, conflict / staged / changed files as a folder tree with hover actions, the commit graph (N5), and the SKILLS · MCP section (N9).

**Code:** `packages/ui/panels/scm/src/ScmPanel.tsx`, `ChangeList.tsx`, `BranchPicker.tsx`, `CommitGraph.tsx` + `graph.ts`, `DiffView.tsx`, `SkillsSection.tsx`, `dialogs.tsx`, `icons.tsx`, `scm.css` (`.scm-*`). All git calls go through `window.agentdeck`.

**Props:** `workspaceId`, `onGoToWorkspace`, `runningAgents`, `api`, `headerActions`, `skills`.

**Tokens:** `surface`; header "SOURCE CONTROL" in `eyebrow`; sections padded `space-sm space-md` with `line-subtle` dividers; branch button `control-sm` with `line-strong`; rows `row` 24, hover `hover`; status letters (M A D R C U) in mono `muted`, conflicts "!" in `attention`; the Merging and Rebasing badge has an `attention` outline. The commit graph uses only `ink` and three warm greys (`--graph-tone-*`), never branch colours.

**Interaction**
- Click the path to copy it. Commit with ⌘↩; the button reads "Commit 3 files" or "Commit all 5 changes".
- Hover a row for + (stage), − (unstage) and discard. Discard asks first: "Discard changes to x? This can’t be undone."
- Click a file for a read-only diff; double-click to open it in the editor.
- Switching branch with changes asks "Switch with changes", "Stash and switch" or Cancel.
- A branch in use on the board shows "◧ frame"; click it to jump there. "n merged branches not on the board" offers Show.
- It refreshes only when the workspace changes, an agent ends its turn, the panel finishes an operation, or you click Refresh. It never watches files.
