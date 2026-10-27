# ContextMenus

ContextMenus are the right-click menus of the board, the frame (header or empty space) and a window title bar. All of them are built from Menu, and plugins appear as one flat PLUGINS group.

**Code:** `packages/ui/canvas/src/react/BoardMenu.tsx` and the menu builders in `src/controller.ts`; plugin rows from `src/plugins/types.ts` (`pluginMenuSection`) and the registry `src/plugins/index.ts`.

**Board (empty space):** New terminal ▸ ⌘N (a shell or each installed agent; "No agents installed" greyed) · New browser ⌘T · New workspace… ⌘⇧N · Add project… · Show all ⌘1. New things open where you right-clicked.

**Frame:** New terminal ▸ · New browser · Rename… · Copy path · Reveal in Finder · Open in editor · Open in system terminal · Approval history… · Auto-arrange new windows (checked) · PLUGINS · Delete workspace….

**Terminal title bar:** Rename… · Open in another workspace ▸ · Fork conversation into… ▸ (agents that support it; greyed with the reason otherwise) · Copy folder path · Background agents… (when there are any) · PLUGINS (Auto-approve, Usage) · Close ⌘W.

**Rules**
- Plugins are listed flat under the `PLUGINS` heading, checked when on; a second click turns them off.
- A plugin that cannot attach is greyed with its reason in the hint: "Not supported for kimi yet", "Not supported for shell".
- `agentsOnly` plugins (Auto-approve) are not listed at all for shells or custom commands.
- Browser windows have no PLUGINS group yet.
