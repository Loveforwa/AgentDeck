// 调 tmux 命令：固定 -L <socket> -f <tmux.conf>，环境用 serverEnv。

import { execFile } from 'node:child_process';
import { AgentDeckError } from '@agentdeck/contracts';
import type { Env } from './env.ts';

/** 最低版本 3.5：extended-keys-format（codex 的 Shift+Enter）从 3.5 开始才有，见 docs/decisions.md。 */
export const MIN_TMUX_VERSION = { major: 3, minor: 5 } as const;

/** attach 时声明的外层（xterm.js）能力，见 AGENTS.md 问题 4。不写进 tmux.conf，免得用户用 Terminal.app attach 时颜色错。 */
export const CLIENT_FEATURES = 'RGB,extkeys,hyperlinks,sync,strikethrough,usstyle,overline';

export interface TmuxRunner {
  readonly path: string;
  readonly socket: string;
  readonly config: string;
  readonly env: Env;
  /** 运行一组 tmux 命令（参数里单独的 ';' 是命令分隔符），返回 stdout。 */
  run(args: string[]): Promise<string>;
  /** 带 -L -f 的完整参数，node-pty 起 attach 用。 */
  argv(args: string[]): string[];
}

/** tmux 返回非 0。stderr 原样放在 detail 里。 */
export class TmuxError extends Error {
  readonly args: string[];
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(args: string[], stderr: string, exitCode: number | null) {
    super(`tmux ${args[0] ?? ''} failed: ${stderr.trim() || `exit ${exitCode}`}`);
    this.name = 'TmuxError';
    this.args = args;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }

  /** 服务没在跑（还没起过，或者已经退出）。 */
  get noServer(): boolean {
    return /no server running|error connecting to|server exited/i.test(this.stderr);
  }

  get sessionMissing(): boolean {
    return /can't find session|session not found|no such session/i.test(this.stderr);
  }

  get duplicateSession(): boolean {
    return /duplicate session/i.test(this.stderr);
  }
}

export function createRunner(opts: { path: string; socket: string; config: string; env: Env; timeoutMs?: number }): TmuxRunner {
  const base = ['-L', opts.socket, '-f', opts.config];
  const timeout = opts.timeoutMs ?? 10_000;
  return {
    path: opts.path,
    socket: opts.socket,
    config: opts.config,
    env: opts.env,
    argv: (args) => [...base, ...args],
    run(args) {
      return new Promise((resolve, reject) => {
        execFile(
          opts.path,
          [...base, ...args],
          { env: opts.env, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
          (err, stdout, stderr) => {
            if (err) {
              const code = typeof err.code === 'number' ? err.code : null;
              reject(new TmuxError(args, `${stderr ?? ''}${err.killed ? ' (timed out)' : ''}` || err.message, code));
              return;
            }
            resolve(stdout);
          },
        );
      });
    },
  };
}

export interface TmuxVersion {
  raw: string;
  major: number;
  minor: number;
}

/** 解析 `tmux -V`：“tmux 3.6a”“tmux 3.5”“tmux next-3.7”“tmux openbsd-7.6”（OpenBSD 自带的按够新算）。 */
export function parseTmuxVersion(output: string): TmuxVersion | null {
  const raw = output.trim();
  if (/openbsd-/i.test(raw)) return { raw, major: 99, minor: 0 };
  const m = /(\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return { raw, major: Number(m[1]), minor: Number(m[2]) };
}

export function versionAtLeast(v: TmuxVersion, min: { major: number; minor: number }): boolean {
  return v.major > min.major || (v.major === min.major && v.minor >= min.minor);
}

const INSTALL_HINT = 'Install or upgrade it with: brew install tmux';

/** 启动时检查 tmux 在不在、版本够不够；不够抛 tmux-unavailable（界面显示一页说明和 Retry）。 */
export async function checkTmux(path: string | null, env: Env): Promise<TmuxVersion> {
  if (!path) {
    throw new AgentDeckError({ code: 'tmux-unavailable', message: 'tmux is not installed.', detail: `AgentDeck needs tmux 3.5 or later. ${INSTALL_HINT}` });
  }
  const out = await new Promise<string>((resolve, reject) => {
    execFile(path, ['-V'], { env, timeout: 5000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${stderr || err.message}`));
      else resolve(stdout);
    });
  }).catch((e: unknown) => {
    throw new AgentDeckError({
      code: 'tmux-unavailable',
      message: 'tmux could not be started.',
      detail: `${path} -V failed: ${e instanceof Error ? e.message : String(e)}\n${INSTALL_HINT}`,
    });
  });
  const v = parseTmuxVersion(out);
  if (!v || !versionAtLeast(v, MIN_TMUX_VERSION)) {
    throw new AgentDeckError({
      code: 'tmux-unavailable',
      message: `tmux 3.5 or later is required (found ${v ? `${v.major}.${v.minor}` : out.trim() || 'unknown'}).`,
      detail: `${path}: ${out.trim()}\n${INSTALL_HINT}`,
    });
  }
  return v;
}

/** 给 sh 用的单引号转义。 */
export function shQuote(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * pipe-pane 的命令会先经过 tmux 的格式展开和 strftime：`#{...}` 是格式，`%s` 会被换成时间戳（实测）。
 * 我们自己拼的部分不用 # 和 %，只有路径需要转义。
 */
export function tmuxFormatEscape(s: string): string {
  return s.replace(/#/g, '##').replace(/%/g, '%%');
}
