<div align="center">

<img src="apps/desktop/build-resources/icon.png" width="96" height="96" alt="AgentDeck icon">

# AgentDeck

Run several coding agents side by side on one whiteboard, one git worktree per branch.

<a href="https://github.com/Loveforwa/AgentDeck/releases/latest"><img src="https://img.shields.io/badge/Download_for_macOS-.dmg-1a1a1a?style=for-the-badge&logo=apple&logoColor=white" alt="Download AgentDeck for macOS"></a>

macOS (Apple silicon or Intel) · needs [tmux](https://github.com/tmux/tmux) 3.5+ and the agents you want to use · [how to open the unsigned app](#install)

**English** · [简体中文](docs/readme/README.zh-CN.md) · [日本語](docs/readme/README.ja.md) · [한국어](docs/readme/README.ko.md) · [Español](docs/readme/README.es.md) · [Français](docs/readme/README.fr.md) · [Deutsch](docs/readme/README.de.md)

</div>

<p align="center">
  <img src="docs/images/demo.gif" width="960" alt="A Claude Code terminal opens three subagent terminals through AgentDeck's MCP server; then ⌘J jumps to another agent that is waiting for approval, and the source control panel follows the focused terminal">
</p>

AgentDeck is a desktop app for working with Claude Code, Codex, Pi, Oh My Pi, Kimi and plain shells at the same time. Each terminal is a real TUI session on a zoomable board. Each branch you work on gets a frame backed by its own git worktree, so agents working on the same repository don't edit each other's files.

AgentDeck uses the agents already installed on your Mac. It doesn't bundle them, and it doesn't change their global configuration: hooks and its MCP server are passed as launch arguments.

## What it does

### A frame for each branch

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/overview-dark.webp">
  <img src="docs/images/overview-light.webp" alt="The board with three workspace frames: two worktrees of a web shop project and the main folder of another repository, each with agent and shell terminals" width="960">
</picture>

Add a project, pick a branch, and AgentDeck creates the worktree and puts a frame for it on the board. Terminals and web windows opened in the frame start in that folder. Terminals run in AgentDeck's own tmux server, so they keep running after you close the window. After a reboot, AgentDeck offers to restore the last session: agents resume their conversation, shells reopen in the same folder.

### See which agent is waiting for you

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/status-dark.webp">
  <img src="docs/images/status-light.webp" alt="A Claude Code terminal waiting for permission to run npm test, with a yellow status light; the top bar shows 4 running and 1/1 waiting" width="960">
</picture>

Every terminal has a status light: green while the agent is running, yellow when it is waiting for you, red on errors. The top bar counts them. Press ⌘J to jump to the next terminal that is waiting, ⌘⇧J to go back.

### Source control next to the board

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/source-control-dark.webp">
  <img src="docs/images/source-control-light.webp" alt="The source control panel showing changed files and a commit graph for the branch of the focused terminal" width="960">
</picture>

The panel on the right follows the focused terminal: changed files in its worktree, staging and commit, a branch switcher and a commit graph across branches. The Skills · MCP section below it lists the skills and MCP servers that terminal's agent starts with.

### Local pages open on the board

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/web-window-dark.webp">
  <img src="docs/images/web-window-light.webp" alt="A dev server printing http://localhost:3000/ in a shell, and the page open in a web window next to it" width="800">
</picture>

Click a `localhost` link in a terminal and the page opens as a web window in the same frame. Clicking the link again brings that window to the front.

### Agents can open windows themselves

AgentDeck runs a local MCP server and attaches it when it starts Claude Code, Codex or Oh My Pi. Through it an agent can open terminals, worktrees and web windows, read another terminal's output, or start a group of subagents. The GIF above is the prompt "use the agentdeck open_terminals tool to open 3 claude subagents, one per package".

### Plugins

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/plugins-dark.webp">
  <img src="docs/images/plugins-light.webp" alt="A Claude Code terminal with the Usage strip above it and the red Auto-approve bookmark below it" width="480">
</picture>

Plugins are in the right-click menu of a terminal. Auto-approve can also be turned on for a whole frame, which covers every agent in it.

- **Auto-approve** answers permission prompts with "allow once". Destructive commands (`rm -rf`, `git push --force`, …), multiple-choice questions and prompts that need typed answers still wait for you.
- **Usage** shows input, output and cache tokens and how full the context is, read from the agent's local session files.

## Install

1. Download the `.dmg` for your Mac from the [latest release](https://github.com/Loveforwa/AgentDeck/releases/latest) (`arm64` for Apple silicon, `x64` for Intel) and drag AgentDeck to Applications.
2. Install tmux 3.5 or newer and git:
   ```sh
   brew install tmux
   xcode-select --install   # git, if you don't have it yet
   ```
3. Install the agents you want to use and log in to each one once in a normal terminal (`claude`, `codex`, `pi`, `omp`, `kimi`). AgentDeck finds them through your login shell's `PATH`.
4. Open AgentDeck. The app is not notarized, so macOS blocks the first launch:
   - Right-click AgentDeck in Applications, choose **Open**, then **Open** again.
   - On macOS 15 and later, open it once, then go to **System Settings › Privacy & Security** and click **Open Anyway**.
   - Or remove the quarantine flag: `xattr -dr com.apple.quarantine /Applications/AgentDeck.app`

AgentDeck keeps its data (board, settings, worktrees) in `~/.agentdeck`.

## Build from source

You need macOS, Node.js 22.12+, pnpm 10, tmux 3.5+ and git.

```sh
pnpm install
node apps/desktop/node_modules/electron/install.js   # first time only: downloads Electron

pnpm dev     # run AgentDeck from source (data in .agentdeck-dev/, separate tmux server)
pnpm check   # typecheck, lint, color and module-boundary checks, unit tests
pnpm e2e     # end-to-end tests with Playwright (opens app windows)
pnpm dist    # build the .dmg files into apps/desktop/dist/
```

The code is a pnpm monorepo: Electron and React for the app, xterm.js for terminals, React Flow for the board. Each package has an `AGENTS.md` that describes what it does; most internal docs are written in Chinese.

## License

License: TBD
