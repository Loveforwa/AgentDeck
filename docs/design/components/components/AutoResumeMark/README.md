# AutoResumeMark

AutoResumeMark is how the Auto-resume plugin (PL6) shows itself. When an agent terminal is stopped by a usage limit, a white bookmark hangs under its bottom-left edge with a small status lamp and when it will resume. Clicking it opens a card where you can change the message AgentDeck types when the limit resets. Since 2026-10-28 it also takes over what was left of the retired Prompt queue (PL3).

**Code:** `packages/ui/canvas/src/plugins/auto-resume.tsx` (the mark and card), `src/plugins/auto-resume-model.ts` (on/off at the three levels, the mark text, what the card can do, `controller.limits` = the LimitService list), styles in `canvas.css` (`.ad-auto-resume-*`). The dev page's Demo menu has "Usage limit: next Auto-resume bookmarks", which steps through every state. Rules in `docs/plugins.md`.

**When it shows:** only while this terminal is in one of LimitService's limited accounts; it goes away when the account leaves the list. Turned on but not limited, nothing hangs. With Auto-resume off it still hangs, grey, so you can Resume now.

**States** (a 7px lamp, then the text; the hover is the card's status line)
- **Yellow** (`status-waiting`): "Paused · resumes 3:31pm" (AgentDeck types the message then), "claude waits for Enter" (claude's own resume went stale), "Reset time unknown" (pi, kimi: only Resume now), "Waiting for you" (the Mac slept through the reset).
- **Green** (`status-running`): "Resuming", "claude resuming".
- **Red** (`status-error`): "Hit the limit again" (it hit the limit right after resuming; stopped).
- **Grey** (a hollow `muted` ring, `muted` text): "claude resumes 3:30pm" (claude resumes by itself; AgentDeck only watches), "Not resumed · you took over", "Skipped", "Resumed", "handled by omp", "Crew resumes", and "Limit · resets 3:30pm" (Auto-resume off, or the terminal was idle on the same account).

**Size:** same hang as AutoApproveMark: `plugin-mark-height` 16, padding 0 7, gap 5, `plugin-mark-text` 9.5px with tabular numbers, bottom corners `plugin-mark-radius` 4, `top: 100%`, `left: space-lg`. `surface` fill, a `line-strong` border without the top edge, `ink` text; `hover` on hover or while the card is open. When the Auto-approve bookmark hangs too, this one sits 4px to its right (the component measures it). A bottom Usage strip moves below either mark.

**Card (Popover, `width: 380px` in `canvas.css`, `padding: 0`; the Popover chrome's `max-width: 320px` currently still applies):**
- Head: **Auto-resume** · resets 3:30pm (`muted`).
- The status line in `text-sm`: `attention` while waiting for you, `status-error` after hitting the limit again, `muted` otherwise.
- **Message** (`text-xs` 600) with **Reset to default** (an underlined `muted` link) once it was changed; a 5-row mono `text-xs` field with a `line-strong` border, prefilled with what will be sent this time: Settings › General › Resume prompt (or the built-in text) plus any subagents that were cut off. Read-only (`muted`) once nothing can change it.
- A `muted` `text-xs` hint: "Sent when this terminal resumes. Only for this limit; next time starts from the default (Settings › Resume prompt)."
- While edited: Save (or "Give to claude" when claude resumes by itself) · Cancel · ⌘↩. ⌘↩ in the field also saves.
- Foot: **Resume now** (greyed before the reset, hover "Available after the limit resets at 3:30pm"; always enabled when the reset time is unknown; greyed while the message is being edited) · **Don’t resume** (ghost, this terminal only). When claude resumes by itself, Don’t resume is replaced by "To stop claude continuing, press Esc in the terminal."

**Rules**
- Only agent terminals can turn it on; shells and custom commands are not listed. It attaches to the board (off by default, right-click empty space) and a terminal, not to project frames (2026-10-29); the terminal's own setting wins, and toggling the board clears the terminals' own settings.
- claude and codex resume on time; pi and kimi only have Resume now; omp handles limits itself (the mark says "handled by omp").
- A changed message is for this limit only; the next limit starts from the default again.
- Colours are only the three status lamps and the status line; everything else is grey. It never uses the plugin red.
- Sending, staggering and Keep Mac awake live in the main process (LimitService); the UI only calls `resumeNow`, `skip` and `setMessage` and never types into the terminal itself.
- It hangs outside the frame and never covers terminal content.
