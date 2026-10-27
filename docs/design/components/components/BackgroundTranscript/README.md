# BackgroundTranscript

BackgroundTranscript is the read-only log window that opens docked beside the sidebar when you select a background agent: its type, task, a "Read-only" pill, a live mono log, and a footer saying how to change it.

**Code:** `packages/ui/canvas/src/react/Background.tsx` (`BackgroundTranscript`, `watchTranscript` / `unwatchTranscript`), styles in `background.css` (`.ad-bg-transcript*`, `.ad-bg-line`).

**Tokens:** a window look (`surface`, `line`, `radius-window`, 28px head with a `line-subtle` border); type in mono 500; title `muted`; pill `hover` fill, 10px `muted`; body mono `text-xs` at 1.6 in `muted`, with prompt and text lines in `ink` and error lines in `status-error`; footer `ground` with mono token count.

**States:** "Loading…", "No transcript yet", "n earlier lines not shown", and "Failed: reason" in red.

**Rules:** you cannot type, approve or stop here. The footer reads "This agent runs inside claude. To change or stop it, tell the main agent." Close it with × (aria "Close transcript") or by selecting the row again.
