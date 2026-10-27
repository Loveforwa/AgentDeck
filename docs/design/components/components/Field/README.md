# Field

Field is the labelled row used in board dialogs and Settings: a muted label column, then a mono text input, select button, checkbox or textarea.

**Code:** `packages/ui/canvas/src/react/fields.tsx`, styles in `canvas.css` (`.ad-field`, `.ad-input`, `.ad-select`, `.ad-checkbox`, `.ad-textarea`).

**Tokens:** grid of a 64px label column (128px in Settings) and the control, gap `space-md`; input `control-md` high, `line-strong` border, `radius-control`, `surface`, mono `text-md`; focus 2px `focus` ring inset; invalid border `ink` (never red); checkbox `accent-color: ink`; field hint `muted`.

**Rules**
- Names, branches and paths are typed in mono.
- An invalid value gets an `ink` border (`aria-invalid`); the reason sits beside or under it in `muted` and says how to fix it. Colour never carries the error alone.
