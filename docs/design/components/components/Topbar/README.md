# Topbar

Topbar is the single 34px row merged with the macOS title bar (MVP v2 · V1). On the left are the project menu and the workspace context; on the right, the running and waiting lamps, Approve all…, and the Settings gear. It has no bar of its own: each button floats over the board on its own `ground` chip.

**Code:** `packages/ui/topbar/src/Topbar.tsx`, `topbar.css` (looks only; canvas mounts it in `Workbench`).

**Props:** `boardName`, `projectName`, `workspace`, `workspaces`, `windows`, `running`, `waiting`, `waitingPosition`, `approvable`, `projectsMenu`, `trafficLights`, `onWaitingClick`, `onApproveAll`, `onSettings`.

**Tokens:** height 34 (`--topbar-height`), left 76px with traffic lights; chips `ground` with `radius-control`, hover `hover`; project `body-strong`; context `muted`; running `status-running` text with an 8px lamp; waiting button `attention` text with a `status-waiting` lamp, `control-sm` high; gear `control-sm` `muted` → `ink`.

**Interaction**
- The first button, right after the macOS buttons, toggles the left manager panel (a 14px sidebar icon, "Show sidebar" / "Hide sidebar", pressed while open).
- The project button opens the Projects menu: projects, then "Project settings…", "New workspace…", "Add project…".
- "1/2 waiting" jumps to the next waiting window (⌘J; ⌘⇧J goes back); it reads "n waiting" when nothing waiting is focused.
- "Approve all…" appears only while permission requests wait. The gear opens Settings (⌘,).
- The bar ignores the pointer except on its buttons, so empty space still pans the board. The macOS drag strip lies under the board (`.ad-workbench-drag`).
- Zero counts are hidden.
