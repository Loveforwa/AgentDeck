// 读一次登录 shell 的环境（docs/decisions.md「agent 用登录 shell 的环境启动」）。
// 从程序坞打开的 Electron 环境很少：PATH 里没有 /opt/homebrew/bin，也没有 .zshrc 里的代理变量（claude 不带代理就是 403）。
//
// 用干净的环境起 `$SHELL -ilc`（tmux-host/AGENTS.md「给组装」第 3 条）：不能把 Electron 自己的环境（ELECTRON_*、
// 在 Claude Code 里启动时的 CLAUDECODE 等）带进去。.zshrc 往 stdout 打字也不怕：先打一个标记，只取标记后面的 env -0。
// 3 秒超时；失败时退回当前进程的环境，并把原因交给界面提示。
//
// 从访达 / 程序坞打开（IS-11）：launchd 给的环境只有 PATH=/usr/bin:/bin:/usr/sbin:/sbin、HOME、USER、SHELL 等几个，
// 有时连 SHELL 都没有（`env -i HOME=$HOME …/AgentDeck` 能复现）。缺的 SHELL、USER、LOGNAME 从系统用户信息（os.userInfo）补，
// 不会因为 SHELL 没设就退回 /bin/zsh 而读错 shell 的配置。读到的（或退回的）PATH 末尾再补上常见的安装目录
// （Homebrew、~/.local/bin、bun、npm 全局目录等，只补存在的），用户的 shell 配置没把它们加进 PATH 时也找得到 tmux、git 和 agent。

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';

export type Env = Record<string, string>;

export interface LoginEnvResult {
  env: Env;
  /** 读失败时的一句话（英文，界面显示）；成功为 null。 */
  warning: string | null;
}

const MARKER = '__AGENTDECK_ENV_BEGIN__';
/** 起登录 shell 时带的最少变量。 */
const BASE_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'];

export function parseEnvOutput(stdout: string): Env | null {
  const start = stdout.indexOf(`${MARKER}\0`);
  if (start < 0) return null;
  const env: Env = {};
  for (const entry of stdout.slice(start + MARKER.length + 1).split('\0')) {
    const i = entry.indexOf('=');
    if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return env.PATH ? env : null;
}

/** 系统里这个用户的信息（os.userInfo），测试可以换掉。 */
export interface UserInfoLike {
  username: string;
  homedir: string;
  shell: string | null;
}

function systemUser(): UserInfoLike | null {
  try {
    const u = userInfo();
    return { username: u.username, homedir: u.homedir, shell: u.shell };
  } catch {
    return null;
  }
}

/** PATH 末尾补上的常见安装目录（按顺序；只补存在的）。 */
export function commonPathDirs(home: string): string[] {
  const dirs = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
  if (home) {
    dirs.push(
      `${home}/.local/bin`, // claude 的安装脚本、pipx
      `${home}/.bun/bin`,
      `${home}/.npm-global/bin`,
      `${home}/Library/pnpm`, // pnpm 全局命令（macOS 默认 PNPM_HOME）
      `${home}/.volta/bin`,
      `${home}/.cargo/bin`,
    );
  }
  return dirs;
}

/** 在 PATH 末尾补上存在、但还不在 PATH 里的常见目录。不改原来的顺序。 */
export function withCommonPaths(env: Env, exists: (dir: string) => boolean = existsSync): Env {
  const path = (env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter(Boolean);
  for (const dir of commonPathDirs(env.HOME ?? '')) if (!path.includes(dir) && exists(dir)) path.push(dir);
  return { ...env, PATH: path.join(':') };
}

/** 起登录 shell 用哪个 shell、带哪些变量：当前环境里有的优先，缺的从系统用户信息补。 */
export function loginShellLaunch(current: Record<string, string | undefined>, user: UserInfoLike | null = systemUser()): { shell: string; env: Env } {
  const env: Env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const k of BASE_KEYS) {
    const v = current[k];
    if (v) env[k] = v;
  }
  if (!env.HOME && user?.homedir) env.HOME = user.homedir;
  if (!env.USER && user?.username) env.USER = user.username;
  if (!env.LOGNAME && env.USER) env.LOGNAME = env.USER;
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  const shell = current['SHELL'] || user?.shell || '/bin/zsh';
  env.SHELL = shell;
  return { shell, env };
}

/** 退回用的环境：当前进程的环境（缺的 HOME、USER、SHELL 照样从系统补），补上常见的 PATH 目录。 */
export function fallbackEnv(
  current: Record<string, string | undefined>,
  opts: { user?: UserInfoLike | null; exists?: (dir: string) => boolean } = {},
): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(current)) if (v !== undefined) env[k] = v;
  const launch = loginShellLaunch(current, opts.user === undefined ? systemUser() : opts.user);
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG']) if (!env[k] && launch.env[k]) env[k] = launch.env[k]!;
  if (!env.PATH) env.PATH = launch.env.PATH!;
  return withCommonPaths(env, opts.exists);
}

export function readLoginEnv(opts: {
  current: Record<string, string | undefined>;
  timeoutMs?: number;
  user?: UserInfoLike | null;
}): Promise<LoginEnvResult> {
  const { current } = opts;
  const user = opts.user === undefined ? systemUser() : opts.user;
  const { shell, env: base } = loginShellLaunch(current, user);
  // printf 的 \0 在 zsh / bash / sh 的内建 printf 里都能用
  const script = `printf '%s\\0' '${MARKER}'; exec env -0`;
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', script],
      { env: base, timeout: opts.timeoutMs ?? 3000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        const env = typeof stdout === 'string' ? parseEnvOutput(stdout) : null;
        if (env) {
          resolve({ env: withCommonPaths(env), warning: null });
          return;
        }
        const why = err ? (err.killed ? 'timed out after 3 seconds' : err.message.split('\n')[0]) : 'no output';
        resolve({
          env: fallbackEnv(current, { user }),
          warning: `Couldn’t read your login shell environment (${why}). Agents use AgentDeck’s own environment, so proxies or PATH entries from your shell profile may be missing.`,
        });
      },
    );
  });
}
