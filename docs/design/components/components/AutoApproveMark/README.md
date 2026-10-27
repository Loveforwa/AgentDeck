# AutoApproveMark

AutoApproveMark is how the Auto-approve plugin (PL1) shows itself. A red bookmark hangs under the bottom-left edge of each terminal it approves for, and a red tag sits in the frame title when the whole workspace has it on. Clicking the bookmark opens a small card.

**Code:** `packages/ui/canvas/src/plugins/auto-approve.tsx` (the mark, card and frame tag), `src/approvals/model.ts` (state), `src/react/approvals.tsx` (first-use confirm, Approval history, Approve all), styles in `canvas.css` (`.ad-auto-approve-*`). Rules in `docs/plugins.md`.

**States**
- **On:** `plugin-auto-approve` fill with `plugin-auto-approve-fg` text "Auto-approve". It flashes for 700ms on each automatic approval, and the hover reads "Auto-approve is on · since 14:02".
- **Needs you:** `attention` fill with `on-attention` text "Needs you". The hover gives the reason: Destructive command, Question for you, Couldn’t approve, or Not supported. It turns red again once handled.
- **Frame tag:** an 18px `radius-inset` "Auto-approve" tag in the frame header. Every agent terminal in the frame gets a bookmark.

**Size:** `plugin-mark-height` 16, padding 0 7, `plugin-mark-text` 9.5px at 600, bottom corners `plugin-mark-radius` 4. It sits at `top: 100%`, `left: space-lg`, touching the outer edge of the border.

**Card (Popover, 300 wide):** "Auto-approve · since 14:02", recent approvals in mono `text-xs` ("14:21  Bash pnpm test auth"), then "Approval history…" and "Turn off".

**Rules**
- Only agent terminals get it: never shells, custom commands or kimi (`canAutoApprove`).
- It hangs outside the frame and never covers terminal content. When a bottom Usage strip is also present, the strip moves below the mark.
- The first time it is turned on, the user confirms once.
- The red means "approving for you", not an error. The window status stays Running.
