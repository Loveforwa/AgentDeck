# Popover

Popover is the floating card anchored to an element, a ref or a point; it hosts menus (`chrome={false}`) and small cards such as the Auto-approve and Usage cards.

**Code:** `packages/ui/kit/src/Popover.tsx`, `popover.css`, positioning in `position.ts`. `PopoverPanel` is the look without behaviour.

**Props:** `open`, `anchor` (element, ref or `{ x, y }` for right-click), `placement` (default `bottom-start`), `chrome`, `autoFocus`, `onClose`, `role`, `aria-label`.

**Tokens:** `raised`, `line` border, `radius-menu`, `shadow-float`, padding `space-md`, max width 320, `z-popover` 1100, fades in over `--motion`.

**Behaviour**
- Flips to the opposite side when there is no room and stays clamped inside the viewport.
- Esc or a click outside calls `onClose`; focus returns to where it was.
- The common body is one sentence plus a right-aligned button row (`.ad-popover-actions`). The preview shows the branch picker from ScmPanel (search, current branch checked, a branch in use elsewhere greyed with "in api-server", New branch…); the Auto-approve and Usage cards are other examples.
