# UsageStrip

UsageStrip is the Usage plugin (PL2): a 24px rounded strip 6px above (or below) a terminal, showing input, output and cache tokens, plus the context window with a meter. Click it for a card; drag its grip to the other edge.

**Code:** `packages/ui/canvas/src/plugins/usage.tsx`, `usage-model.ts` (per-agent number formats, `AGENT_FORMATS`), styles in `canvas.css` (`.ad-usage-*`). Data: `usage.watch`, `usage.changed`; position in `TerminalWindowData.usage`.

**Tokens:** `plugin-strip-height` 24, `plugin-strip-gap` 6, `line-strong` border, pill radius, `surface`, `shadow-mark`, `text-xs` tabular; labels `muted`; meter 46×5 `line` track with an `ink` fill.

**States**
- **Normal.**
- **Attention:** at 85% context or more, the number and meter turn `attention`.
- **No data:** "No usage data" in `muted`, with the reason on hover.
- **Loading:** "Loading…".
- **Dragging:** the border turns `guide` and lifts with `shadow-float`. A 2px `guide` drop line marks the edge it will attach to.

**Numbers** follow each agent's own UI: claude "52.5k / 1m · 5%", codex "27.8K / 475K · 97% left", pi "52k / 1.0M · 5.2%", omp "52K / 1M · 5.2%", kimi "68.8k / 977k · 8%". The hover shows exact counts and the model. As the strip narrows it hides Cache below 500px, Output below 400 and Input below 310; Context always stays.

**Card (340 wide):** the model and "Context window 1m", Last request, Requests, codex's "5h limit 99% left (resets 14:05)" and Weekly limit, then "Move to bottom" (or "Move to top") and "Hide".

**Rules:** the strip stays attached to its own terminal and outside its frame, and does not block clicks on the window. Maximizing leaves room for it. Shell terminals cannot turn it on.
