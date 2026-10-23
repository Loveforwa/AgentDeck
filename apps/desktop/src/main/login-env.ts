// 读一次登录 shell 的环境（docs/decisions.md「agent 用登录 shell 的环境启动」）。
// 从程序坞打开的 Electron 环境很少：PATH 里没有 /opt/homebrew/bin，也没有 .zshrc 里的代理变量（claude 不带代理就是 403）。
//
// 用干净的环境起 `$SHELL -ilc`（tmux-host/AGENTS.md「给组装」第 3 条）：不能把 Electron 自己的环境（ELECTRON_*、
// 在 Claude Code 里启动时的 CLAUDECODE 等）带进去。.zshrc 往 stdout 打字也不怕：先打一个标记，只取标记后面的 env -0。
// 3 秒超时；失败时退回当前进程的环境，并把原因交给界面提示。

import { execFile } from 'node:child_process';

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

/** 退回用的环境：当前进程的环境，补上常见的 PATH 目录。 */
export function fallbackEnv(current: Record<string, string | undefined>): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(current)) if (v !== undefined) env[k] = v;
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${env.HOME ?? ''}/.local/bin`];
  const path = (env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
  for (const dir of extra) if (!path.includes(dir)) path.push(dir);
  env.PATH = path.join(':');
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  return env;
}

export function readLoginEnv(opts: {
  current: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<LoginEnvResult> {
  const { current } = opts;
  const shell = current['SHELL'] || '/bin/zsh';
  const base: Env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const k of BASE_KEYS) {
    const v = current[k];
    if (v) base[k] = v;
  }
  if (!base.LANG) base.LANG = 'en_US.UTF-8';
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
          resolve({ env, warning: null });
          return;
        }
        const why = err ? (err.killed ? 'timed out after 3 seconds' : err.message.split('\n')[0]) : 'no output';
        resolve({
          env: fallbackEnv(current),
          warning: `Couldn’t read your login shell environment (${why}). Agents use AgentDeck’s own environment, so proxies or PATH entries from your shell profile may be missing.`,
        });
      },
    );
  });
}
