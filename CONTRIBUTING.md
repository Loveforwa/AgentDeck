# Contributing to AgentDeck

Thanks for your interest. Bug reports, fixes, support for more agents and new plugins are all welcome.

## Reporting a bug

Open an issue with:

- your macOS version, the AgentDeck version, and `tmux -V`;
- which agent it happened with and that agent's version (`claude --version`, `codex --version`, …);
- what you did, what you expected, and what happened instead. A screenshot helps.

## Sending a change

1. Fork the repository and create a branch.
2. Set up the project as described in [Build from source](README.md#build-from-source).
3. Read the `AGENTS.md` of the package you are changing. It says what the package does and which directories it must not touch.
4. Run `pnpm check` before you push. It runs the typecheck, lint, the color check, the module-boundary check and all unit tests. CI runs the same command on macOS and Ubuntu.
5. Open a pull request. Say what changed and why. For anything visible, attach a screenshot.

A few rules the checks enforce:

- Interface text is English.
- Components contain no color values. Colors and sizes live in `packages/design-tokens`.
- UI packages don't import services, Electron or Node modules. They talk to the main process through `window.agentdeck`. The full boundary rules are in `AGENTS.md`.
- `packages/contracts` only grows. Changes to it go in their own commit (see `packages/contracts/AGENTS.md`).

Most internal docs are written in Chinese. Write issues and pull requests in English or Chinese, whichever you prefer.

## Writing a plugin

A plugin is a small feature attached to a terminal, a web window or a whole frame, toggled from the right-click menu. Auto-approve and Usage are the two that ship today.

- The step-by-step guide is [`.claude/skills/agentdeck-plugin/SKILL.md`](.claude/skills/agentdeck-plugin/SKILL.md). It is written so a coding agent can follow it too. Claude Code picks it up automatically in this repository, and with other agents you can point them at the file.
- The plugin rules, the registry table and the decision log are in [`docs/plugins.md`](docs/plugins.md).

If you have an idea and aren't sure it fits as a plugin, open an issue first and describe it.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
