AgentDeck is a desktop workbench where real coding-agent TUIs (claude, codex, pi, omp, kimi) and shells run in windows on a whiteboard. Each workspace frame is one git worktree and branch; the right panel is source control; localhost links open as browser windows on the board. Everything here is copied from the repository `Loveforwa/AgentDeck` (integrate/W0-W1 @ d51382e): the tokens from `packages/design-tokens`, the component styles verbatim from `packages/ui/**`. When this page and the code disagree, the code wins; fix this page. The same inventory lives in the repository as `docs/components.md` (in Chinese); change both together.

Use this system to build any AgentDeck screen, spec drawing or plugin. Read a component's card before drawing it again: every window part, mark, panel and dialog already exists here with its states and rules.

## The five rules

1. **Warm grey and ink.** Surfaces are `ground`, `surface`, `raised`; text is `ink` and `muted`; lines are `line`, `line-strong`, `line-subtle`. Dark is warm dark grey, never pure black, and shows "lifted" by `raised` being one step lighter than `surface`.
2. **Colour means status, plus agent identity.** Green `status-running` = running. Yellow `status-waiting` (lamp, border) with `attention` (words) = waiting for you. Red `status-error` = error. The only other colours: red `plugin-auto-approve` for the Auto-approve bookmark and frame tag, blue `guide` for layout feedback while you drag or select, Clawd's `mascot*` tokens, and one identity colour per code agent: `agent-claude`, `agent-codex`, `agent-pi`, `agent-omp`, `agent-kimi` (decided 2026-10-26). Agent colours appear only on marks that say which agent this is: today, the 7×7 square at the start of each row in the left manager panel (MP2). The mark is a square, not a dot, so it never reads as a status lamp; the colour is never a fill, border or status anywhere else. Branches, projects and file types get no colour.
3. **No gradients, glow, blur or emoji.** Separate with 1px lines. Only floating things (menus, popovers, dialogs, toasts, a focused or dragged window) get `shadow-float`; marks stuck to a window get the lighter `shadow-mark`. Text glyphs such as ✓ ▸ · ⌘ are fine; pictographic emoji are not.
4. **Product text is English.** Comments, docs and commit messages may be Chinese.
5. **No colour literals in components.** `.ts`/`.tsx` and `.css` under `packages/ui/**` use only `var(--token)`; `pnpm colors` and ESLint reject hex, `rgb()`, `hsl()` and the rest. A new colour is a new token in `packages/design-tokens/src/index.ts` with a value for both themes (text tokens join the contrast test), then `pnpm --filter @agentdeck/design-tokens gen`.

## Content fundamentals

- Name things by what the user sees: windows, frames (workspaces), board, panel. Menu items and buttons are sentence case and start with a verb: "New terminal", "Open in another workspace", "Stop and close", "Restart and resume".
- An item that opens a dialog ends with an ellipsis: "New workspace…", "Rename…", "Approval history…", "Approve all…". A submenu gets ▸.
- Status is one capitalised word, then a middle dot and the age: "Running · 4m", "Waiting · 2m", "Idle · now", "Exited", "Error · exit 1". Ages read "now", "4m", "2h", then a date "Oct 21". The hover gives the detail ("Needs approval" or "Needs reply").
- Counts are lower case after a number: "2 running", "1 waiting", "3 subagents", "5 background agents · 3 running", "✓ 5 done".
- Join parts with " · " (space, middle dot, space): "api-server · feat/oauth", "sub-2 · ui", "BACKGROUND · READ-ONLY".
- Group headings are uppercase `eyebrow` text, with a count after a middle dot where it helps: "PLUGINS", "SOURCE CONTROL", "BOARD", "TERMINALS", "AGENTS · 6", "NEEDS YOU · 2", "IDLE · 3".
- Tags are lower case and quiet: "outside workspace", "lead", "Read-only".
- Toasts state a fact, past tense, with at most one action: "Removed api-server · feat/oauth from the board" + Undo; "Approved 1 request · 2 still need you".
- Errors say what happened and what to do: "Can’t redo: the terminal was restarted. Close it instead." "notes isn’t a Git repository." Use curly apostrophes in UI text.
- A reason after a greyed item goes in the menu hint: "Not supported for kimi yet", "Not supported for shell".
- Names of agents, commands and branches are set in mono; everything else in the UI face.

## Visual foundations

**Colour.** See Colors for every token, its usage and the grounds its text reads on. Text pairs pass 4.5:1 in both themes, with these exceptions kept exact from the source and flagged in their notes: `status-running` and `attention` text on `hover` in light (4.3:1), `status-waiting` as a lamp on `ground` in light (2.9:1), and `line-strong` control borders (1.5:1, by design quiet). The focus ring is `focus` (= `ink`), 2px solid, offset 1px outside or −2px inside rows.

**Type.** Two families: `ui` (Inter Variable) and `mono` (JetBrains Mono Variable), bundled offline from `@fontsource-variable`, with PingFang SC and system fallbacks. The scale is four sizes, `text-xs` 11, `text-sm` 12, `text-md` 13, `text-lg` 15 (dialog titles only), at `leading` 1.45 and weights 400 / 500 / 600. Two exceptions exist in code: `plugin-mark-text` 9.5px for marks hung on a window edge, and 10px for sidebar sub-headings. Use `font-variant-numeric: tabular-nums` wherever numbers update (zoom %, Usage, times).

**Spacing.** `space-2xs` 2 · `xs` 4 · `sm` 8 · `md` 12 · `lg` 16 · `xl` 20 · `2xl` 24. Controls are `control-sm` 22 and `control-md` 26 high; rows are `row` 24.

**Radius.** No square corners. `radius-control` 6 for controls, `radius-window` 8 for windows, `radius-menu` 8 for menus and dialogs, `radius-panel` 10 for the side panel, `radius-frame` 12 for frames, `radius-inset` 4 only for highlights inside a rounded container.

**Motion.** One curve: `--motion` = 140ms `cubic-bezier(0.2, 0, 0, 1)`, used for hover fills, borders and fades. Menus and dialogs fade in; toasts rise 4px. No bounce or scale-in. With reduced motion the duration is 0. Window flash on re-open is 600ms, the Auto-approve flash 700ms, Clawd's sprite 700ms steps.

**Layout.**
- The window is one row: a transparent 34px top bar floats over the board, left 76px reserved for the macOS buttons.
- The board is a React Flow canvas on `ground` with a 20px dot grid in `line-strong`, hidden below 50% zoom; zoom runs 25–200%.
- Frames have a 36px header. Windows have a 28px title bar. Windows and frames keep a 20px gap; snapping engages within 6 screen px.
- The left manager panel (MP2; toggled from the far left of the top bar) takes its own column 4px in from the edges, 240–480 wide, with `radius-panel`; the board narrows beside it.
- The right panel floats 4px in from the edges, is 280–480 wide (⌘B toggles), and collapses to a 28px rail.
- A window group's sidebar is 168 wide, 8px right of its lead.
- Plugin marks hang outside the window frame. The bookmarks (left: the red Auto-approve, then the white Auto-resume with its status lamp, 4px apart) and the background hint (right) hang from the bottom edge; the Usage strip sits 6px above or below, below the bookmarks when both are at the bottom. They never cover terminal content.

**Interaction states.**
- Hover fills a row or ghost control with `hover` and darkens a `muted` icon to `ink`.
- Selected rows are `hover` plus weight 600.
- Disabled is `opacity-disabled` 0.4.
- A focused window gets an `ink` border plus `shadow-float`. A waiting window gets a `status-waiting` border. A selected window gets a 2px `guide` outline.
- Window actions (maximize, close) appear only on hover or focus.

## Iconography

Icons are inline SVG in the components, never an icon font or images: 12–15px, `fill="none"`, `stroke="currentColor"`, stroke width 1.3, round caps. They take `muted` and turn `ink` on hover. The set lives in `WindowShell.tsx` (maximize, restore, close), `Topbar.tsx` (chevron, gear), `FrameNodeView.tsx` (Tidy, Columns, Rows, Auto-arrange), `ManagerPanel.tsx` (window, folder, plus, search, pin), `panels/scm/src/icons.tsx` and the browser widget; the Icons card shows them. Status is never an icon: it is a lamp (a dot, a hollow ring, or a short line for exited). No logo exists in the repository; the product name is set in plain type.

## Where things live

| Layer | Package | Rule |
| --- | --- | --- |
| Tokens | `packages/design-tokens` (`src/index.ts` → generated `tokens.css`) | the only place values are defined |
| Kit | `packages/ui/kit` (`ad-` classes) | Button, Menu, Popover, Dialog, RadioGroup, Toast; depends on tokens only |
| Window frame | `packages/ui/window-shell` | looks and gestures only; used only by canvas |
| Top bar | `packages/ui/topbar` | looks only; used only by canvas |
| Board | `packages/ui/canvas` | frames, window nodes, plugin marks, sidebars, menus, dialogs, panel shell |
| Windows | `packages/ui/widgets/terminal`, `widgets/browser` | register through `@agentdeck/ui-canvas/registry` only |
| Panels | `packages/ui/panels/scm`, `panels/manager` | no panel imports another |

UI packages import only contracts, design-tokens, `ui/kit` and the canvas registry; widgets never import each other; only `apps/desktop` wires services to UI (`pnpm boundaries`). Plugins follow `docs/plugins.md` and `.claude/skills/agentdeck-plugin/SKILL.md`.

## Spec drawings vs the code

The design canvas (https://claude.ai/artifact/2GtB5izXeQSV3NecUYuLAo) has a parts page used to draw the spec boards (see SpecParts). Those parts and some early boards predate the V2 traffic lights. They draw waiting in orange (#C2410C), the running dot in ink, and Auto-approve "Needs you" as orange #B45309 with an orange window border. They also mix several waiting yellows (#E8A317, #BF8700, #8A6700) and error reds (#B91C1C). Build from the tokens here instead. Waiting is `status-waiting` for the lamp and border and `attention` for the words; "Needs you" is the `attention` fill with `on-attention` text. Board 14's mock shows a 36px top bar; the code is 34px.
