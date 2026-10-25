// @agentdeck/tmux-host：TerminalHost 的真实实现（线 1 · T1）。
// 以后跑在 Electron 的 utilityProcess 里；接线留给第 3 波组装（apps/desktop），见 AGENTS.md「给组装」。

export { startTmuxHost, DEFAULT_TMUX_CONF, resolveDefaultTmuxConf, cleanTitle, parseSessions } from './host.ts';
export type { LinkWatcher, SessionRow, TmuxHost, TmuxHostOptions } from './host.ts';
export { paneEnv, serverEnv, findExecutable } from './env.ts';
export type { Env, EnvSource } from './env.ts';
export { CLIENT_FEATURES, MIN_TMUX_VERSION, checkTmux, parseTmuxVersion } from './tmux.ts';
export { classifyInput } from './input.ts';
export { exitCodeOf, signalNumber, KILLED_EXIT_CODE } from './signals.ts';
export { ensureSpawnHelperExecutable } from './pty.ts';
export { displayCommandLine, foregroundCommands, parsePsColumns, sanitizePrefill, type PsRunner } from './foreground.ts';
