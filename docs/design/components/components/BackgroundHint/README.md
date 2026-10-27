# BackgroundHint

BackgroundHint is the small tab under the bottom-right edge of a main agent terminal (N10, board 13) that counts the agent's own background subagents for this turn. Clicking it opens or closes the background panel.

**Code:** `packages/ui/canvas/src/react/Background.tsx` (`BackgroundHint`), text from `src/model/background.ts` (`hintOf`), styles in `background.css` (`.ad-bg-hint`, `.ad-bg-lamp`).

**States**
- **running:** a green lamp and "5 background agents · 3 running".
- **failed:** a red lamp and "5 background agents · 1 failed · 2 running".
- **done:** grey "✓ 5 done", which clears at your next message.
- **none:** no hint at all.
- **Open:** `hover` fill and `aria-expanded`.

**Size and tokens:** `plugin-mark-height` 16, padding 0 7, `plugin-mark-text`; `surface` with a 1px `line-strong` border (no top border) and bottom corners `plugin-mark-radius`. It sits at `top: 100%`, `right: space-lg`. Lamps are 7px (`status-running`, `status-error`).

**Rules**
- It mirrors the Auto-approve bookmark: the bookmark goes left, the hint right. A bottom Usage strip moves below both.
- The terminal menu's "Background agents…" reopens the panel after the hint is gone.
- Nothing here is saved or restored across restarts.
