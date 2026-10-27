# SettingsDialog

SettingsDialog is the app settings (X12, TC-15): a dialog with a 168px left nav (projects, then General) and a page of labelled fields. Save writes every changed page at once.

**Code:** `packages/ui/canvas/src/react/SettingsDialog.tsx`, drafts in `src/model/settings.ts`, styles in `canvas.css` (`.ad-settings*`, `.ad-field`).

**Open it:** the top-bar gear, Projects ▾ › project › Project settings…, ⌘, (even inside inputs), or the app menu. With no project given, it opens on the project of the focused window or selected frame.

**Tokens:** the nav is a column with a `line-subtle` right border and `control-md` items; `hover` marks the current page (500 weight, `aria-current="page"`). Page fields are 128px label grids, paths in mono `muted`, hints `text-sm` `muted`; both sides scroll at 56vh.

**Pages:** each project has Name, Path, Base branch, Worktree location, Files to copy and Setup command. General has Closing the window ("Keep AgentDeck running in the background" or "Quit AgentDeck"), Notifications, Default agent, Editor command and Terminal app.

**Behaviour**
- Switching pages keeps the drafts. Save sends only the changed fields and closes when everything succeeds; on failure a Toast explains and the dialog stays.
- "Open settings.json" sits at the bottom left.
