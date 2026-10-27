# Button

Button is the one button in AgentDeck: `default` (surface fill, `line-strong` border), `primary` (ink fill, at most one per group) and `ghost` (no border, for title bars and toolbars), in `md` (26px) or `sm` (22px).

**Code:** `packages/ui/kit/src/Button.tsx`, `button.css` · `import { Button } from '@agentdeck/ui-kit'`

**Props:** native `<button>` props plus `variant` (`default` | `primary` | `ghost`) and `size` (`md` | `sm`). `type` defaults to `button`; `disabled` is native.

**Tokens:** `control-md` / `control-sm` height, `radius-control`, `surface` + `line-strong` (default), `ink` + `on-ink` (primary), `hover` / `ink-hover` on hover, `opacity-disabled`, focus ring 2px `focus` offset 1px, `text-md` (`text-sm` when small).

**Rules**
- Label is a verb in sentence case: "Delete", "Stop and close", "Restart and resume". End with … when it opens a dialog ("Approve all…").
- In a dialog or popover row: secondary first, primary last, on the right.
- Primary means "the thing this view is for". Destructive actions are still `primary` ink, never red: colour is for status.
- Icon-only ghost buttons need an `aria-label` ("Settings", "Close", "Collapse panel").
- No pointer cursor: buttons keep `cursor: default` like a desktop app.
