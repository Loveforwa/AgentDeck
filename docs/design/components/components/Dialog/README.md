# Dialog

Dialog is the modal for decisions: a title, body paragraphs or fields, and a right-aligned button row (secondary first, primary last).

**Code:** `packages/ui/kit/src/Dialog.tsx`, `dialog.css` (`Dialog`, `DialogPanel`, `DialogText`). The board's dialogs are in `packages/ui/canvas/src/react/dialogs.tsx` and `approvals.tsx`: New workspace, Delete workspace, Open new (W5), Stop terminal, Rename, Restore session, Approve all, Approval history. Settings is its own card.

**Props:** `title`, children (body), `actions`, `width`, `initialFocus`, `onClose`. `DialogText` has a `tone`: `default`, `muted`, or `attention` (only for risk of losing work).

**Tokens:** `raised`, `line`, `radius-menu`, `shadow-float`, padding `space-xl`; title `dialog-title` (15px, 600); body gap `space-sm`; actions margin `space-xl`; backdrop `scrim` at `z-dialog`, 18vh from the top.

**Behaviour**
- Esc calls `onClose`; a backdrop click does nothing by default.
- First focus goes to `initialFocus`, then `[data-autofocus]`, then the first focusable element in the body, then the first button.
- Tab stays inside the dialog, and focus is restored on close.

**Rules**
- The title is a question or an action with its object: "Delete workspace api-server · feat/oauth", "Restore your last session?", "Approve these requests?".
- Risk text uses `attention` ("Uncommitted changes in this worktree will be lost"), and the destructive button stays disabled until "I understand these changes will be lost" is ticked.
- Closing a running terminal confirms inside that window only, not app-wide (`.ad-window-confirm`, see TerminalWindow).
