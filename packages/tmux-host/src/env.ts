// 进程环境：tmux 服务、attach 客户端、窗格里的程序各用什么环境。
// 登录 shell 的环境由 apps/desktop 读出后通过 startTmuxHost 的 env 传进来（docs/decisions.md），这里不自己读。

import { constants, accessSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export type Env = Record<string, string>;
/** 环境可能变（Settings 里 Refresh 后重新读了登录 shell），所以也可以传函数，每次建会话时取最新的。 */
export type EnvSource = Env | (() => Env);

export function readEnv(source: EnvSource): Env {
  return typeof source === 'function' ? source() : source;
}

/**
 * 不能带进窗格的变量。
 * - 终端身份：TERM 由 tmux 的 default-terminal 决定，COLORTERM 在 tmux.conf 里设；外层终端的标识会让程序以为自己直接跑在 iTerm 等里面。
 * - 宿主注入：在 Claude Code、Electron 里启动时会带上它们（F7 问题 5），例如 CLAUDECODE=1 会让窗格里的 claude 以为自己是嵌套的。
 *   正常从程序坞打开 AgentDeck 时登录 shell 的环境里没有这些；这里只是兜底。
 */
const DROP = new Set([
  'TERM',
  'TERMINFO',
  'TMUX',
  'TMUX_PANE',
  'COLORTERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  'ITERM_SESSION_ID',
  'ITERM_PROFILE',
  'SHLVL',
  'PWD',
  'OLDPWD',
  '_',
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_ENTRYPOINT_ON_REQUESTS',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SSE_PORT',
]);
const DROP_PREFIXES = ['ELECTRON_', 'CLAUDE_AGENT_SDK_', 'VSCODE_', 'npm_', 'GHOSTTY_', 'KITTY_', 'WEZTERM_', '__CF', 'XPC_'];

/** 传给窗格（new-session -e）的环境：登录 shell 的环境去掉上面这些。 */
export function paneEnv(login: Env): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(login)) {
    if (DROP.has(k) || DROP_PREFIXES.some((p) => k.startsWith(p))) continue;
    // bash 导出的函数（BASH_FUNC_x%%）之类不是普通变量名的不带
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    out[k] = v;
  }
  if (!out.LANG) out.LANG = 'en_US.UTF-8';
  return out;
}

/**
 * tmux 服务和 attach 客户端进程自己的环境：只留最少的几个（F7 问题 5）。
 * 服务的全局环境取自第一次启动它的进程，所有会话都会继承，所以这里不放任何多余的东西；
 * 窗格需要的其余变量由 new-session -e 一个个给。
 */
export function serverEnv(login: Env): Env {
  const out: Env = {};
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR']) {
    const v = login[k];
    if (v) out[k] = v;
  }
  out.LANG = login.LANG || 'en_US.UTF-8';
  return out;
}

/** 在 env.PATH 里找可执行文件；command 带 / 时只检查它本身（相对路径按 cwd 算）。 */
export function findExecutable(command: string, env: Env, cwd?: string): string | null {
  if (!command) return null;
  if (command.includes('/')) {
    const full = isAbsolute(command) ? command : join(cwd ?? process.cwd(), command);
    return isExecutableFile(full) ? full : null;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
