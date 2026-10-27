# Clawd

Clawd is the small pixel mascot that peeks up from the bottom-left of the board about every 10 seconds, does one thing (lifting, coding or eating) for 6 seconds, and slides back. It is decoration only.

**Code:** `packages/ui/canvas/src/react/Clawd.tsx` (one `<rect>` per cell, two frames per activity, 2px cells in a 54×32 sprite); styles in `canvas.css` (`.ad-clawd*`).

**Tokens:** `mascot` body, `mascot-eye` eyes, `mascot-prop` barbell, laptop and bowl, `mascot-food`, `surface` screen; it slides over 320ms on `--motion-ease`, and its frames swap every 350ms in steps.

**Rules**
- It ignores the pointer and is hidden from screen readers; it never covers the zoom button or the hints.
- With reduced motion it shows one still frame.
- Its orange is not a status colour, so never reuse `mascot` anywhere else.
