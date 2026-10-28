# SettingsDialog

SettingsDialog is the app settings (X12, TC-15): a dialog with a 168px left nav (projects, then General) and a page of labelled fields. Save writes every changed page at once.

**Code:** `packages/ui/canvas/src/react/SettingsDialog.tsx`, drafts in `src/model/settings.ts`, styles in `canvas.css` (`.ad-settings*`, `.ad-field`).

**Open it:** the top-bar gear, Projects ▾ › project › Project settings…, ⌘, (even inside inputs), or the app menu. With no project given, it opens on the project of the focused window or selected frame.

**Tokens:** the nav is a column with a `line-subtle` right border and `control-md` items; `hover` marks the current page (500 weight, `aria-current="page"`). Page fields are 128px label grids, paths in mono `muted`, hints `text-sm` `muted`; both sides scroll at 56vh.

**Pages:** each project has Name, Path, Base branch, Worktree location, Files to copy and Setup command. General has Closing the window ("Keep AgentDeck running in the background" or "Quit AgentDeck"), Notifications, Default agent, Editor command, Terminal app and Resume prompt.

**Resume prompt (PL6):** a 3-row multi-line field (`.ad-input.ad-textarea`) whose placeholder is the built-in text ("Your usage limit has reset. Continue the task you were working on when the limit stopped you, from where you left off. Don't redo work that is already done."), with the hint "Auto-resume sends this when a usage limit resets. Empty uses the built-in text; you can still change it for one limit from the bookmark". Saved trimmed; empty means the built-in text. It moves to an Agents page once that exists (AH4). The per-limit edit is in AutoResumeMark's card.

**Behaviour**
- Switching pages keeps the drafts. Save sends only the changed fields and closes when everything succeeds; on failure a Toast explains and the dialog stays.
- "Open settings.json" sits at the bottom left.
