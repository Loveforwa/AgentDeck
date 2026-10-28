# Toast

Toast is a one-line fact at the bottom centre of the window with at most one action; it disappears on its own.

**Code:** `packages/ui/kit/src/Toast.tsx`, `toast.css`. Wrap the app in `ToastProvider`; call `useToast().show({ message, action?, duration? })`.

**Tokens:** `ink` fill with `on-ink` text (so it inverts in dark), `radius-control`, `shadow-float`, min height 32, max width 480, `z-toast`; enters by rising 4px with a fade over `--motion`. Action: underlined, weight 600, focus ring `on-ink`.

**Behaviour**
- It closes after 4 s, or 6 s when it has an action. Hover or focus pauses the timer.
- At most 3 toasts show at once; the oldest is dropped.
- When the user typed in the last 2 s, a service notification only flashes the window and shows no toast.
- Window components use `useOptionalToast()`: it returns `null` instead of throwing when there is no `ToastProvider` (a widget alone in a test or dev page), so they skip the toast.

**Copy:** a past-tense fact: "Removed api-server · feat/oauth from the board" + Undo, "Restored 5 terminals.", "claude · agentdeck · feat/login: Tests passed".
