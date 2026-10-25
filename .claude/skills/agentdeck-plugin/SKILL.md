---
name: agentdeck-plugin
description: Build or change an AgentDeck plugin (a small feature attached to a terminal, web window or frame on the board, toggled from the right-click menu, like Auto-approve or Usage). Use when asked to add a plugin, change an existing one, or work out whether an idea fits as a plugin.
---

# Building an AgentDeck plugin

A plugin is a small feature attached to one thing on the board. While it is on, that thing shows a visible mark next to it. Every plugin is turned on and off from the **PLUGINS** group of the right-click menu. Plugins run inside AgentDeck as ordinary modules: there is no sandbox and no separate install step, so a new plugin lands as a pull request to this repository.

The two existing plugins are the best reference:

- **Auto-approve**: `packages/ui/canvas/src/plugins/auto-approve.tsx` (a red bookmark under the terminal; backend in `packages/agent-adapters`).
- **Usage**: `packages/ui/canvas/src/plugins/usage.tsx` and `usage-model.ts` (a strip above or below the terminal; backend in `packages/agent-adapters/src/usage/`).

The full rules, the plugin registry table and the decision log are in `docs/plugins.md` (Chinese). Read it before starting.

## 1. Answer these before writing code

Write the answers into the registry table in `docs/plugins.md` first.

1. **What can it attach to?** One or more of `terminal`, `browser` (a web window), `frame` (a workspace frame: one worktree and branch; turning a plugin on for a frame covers everything inside it, including windows opened later) and `board` (not wired up yet).
2. **Which agents does it support?** `claude`, `codex`, `pi`, `omp`, `kimi`, or `'all'`. Agents outside the list stay in the menu, greyed out with the reason (`Not supported for kimi`). If the plugin makes no sense for a plain shell, set `agentsOnly: true` so shell terminals don't list it at all.
3. **What does the mark look like and where does it sit?** It must not cover the window's content.
4. **Where does its data come from?** If it only needs board state, it is a UI-only plugin. If it needs to read files, watch processes or talk to an agent, it needs a backend service (step 3).
5. **What does the user see when it fails?** If the plugin cannot read its data or an action didn't take effect, show that. Never guess a number and never fail silently.

## 2. The UI part

1. Create `packages/ui/canvas/src/plugins/<name>.tsx` and export a `PluginDefinition` (see `plugins/types.ts`):

   ```tsx
   export const myPlugin: PluginDefinition = {
     id: 'my-plugin',
     label: 'My plugin',            // menu text, English
     attachesTo: ['terminal'],
     agents: ['claude', 'codex'],   // or 'all'
     isOn: (c, t) => t.kind === 'window' && readSettings(c.windowById(t.windowId)).on,
     toggle: (c, t) => { /* flip the setting and write it to the board */ },
     WindowMark: MyMark,            // rendered next to the window while on
     // FrameMark, availability, menuExtras, agentsOnly are optional
   };
   ```

2. Add it to `PLUGINS` in `packages/ui/canvas/src/plugins/index.ts`. The menu entry and the marks are generated from that list; don't edit the context menu or the window node.
3. Persist the on/off state with the board, so it survives a restart. Usage stores it on the terminal's window data (`TerminalWindowData.usage`). Turning the plugin off must remove everything it created: the mark, listeners, any files it wrote.
4. Tests go in `packages/ui/canvas/test/<name>.test.tsx`. Copy the pattern in `usage.test.tsx` or `auto-approve.test.tsx`: build a board with the fake API, open the right-click menu, toggle the plugin and check the mark.

## 3. The backend part (only if the plugin needs data)

The UI never imports services or Node modules. It reaches the main process through `window.agentdeck` (`c.api` inside the canvas). A plugin with its own data therefore goes through these steps:

1. **Contract**: add the API and events in `packages/contracts/src/` (for example `usage.ts`). Contracts are additive only. Commit the change on its own and read `packages/contracts/AGENTS.md` first.
2. **Service**: implement it in the service package that owns the data (session files and agent hooks live in `packages/agent-adapters`). Services must not import each other or any UI package.
3. **Wiring**: create the service in `apps/desktop/src/main/index.ts` and register it with `registry.register('<name>', service)`. Only `apps/desktop` connects services to the UI.
4. **Fake**: add a fake in `tools/fakes` so the canvas tests and the canvas dev page (`packages/ui/canvas/dev/`) work without real agents.

Passing something to an agent (a hook, an MCP server, an extension) is done per launch, through the arguments or environment AgentDeck starts the agent with. **Never write to the user's own agent config** (`~/.claude*`, `~/.codex`, `~/.pi`, `~/.omp`, `~/.kimi*`).

If the plugin depends on an agent's screen text, prompt format or session-file layout, write down the agent version you checked against (see `packages/agent-adapters/src/adapters/known.ts`). Agents change these between releases.

## 4. Look and text

- All text in the interface is English.
- No color values in components. Use the tokens in `packages/design-tokens` and the parts in `packages/ui/kit`. If the mark needs its own color, add a dedicated token there (see `--plugin-auto-approve`).
- Color only means status: green running, yellow waiting for you, red error. The red of the Auto-approve bookmark is the one plugin exception. No gradients, glows or emoji.

## 5. Before opening the pull request

- `pnpm check` passes. It runs typecheck, lint, the color check, the module-boundary check (`.dependency-cruiser.cjs`) and all unit tests.
- The registry table and decision log in `docs/plugins.md` are updated.
- Try it in the real app with `pnpm dev`: turn it on and off, restart the app, close the window. Attach a screenshot of the mark to the pull request.
