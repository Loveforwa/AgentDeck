// 在子进程里跑 git：异步、带超时、不经过 shell。出错统一变成 AgentDeckError。

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AgentDeckError } from '@agentdeck/contracts';

export interface RunnerOptions {
  /** git 可执行文件，默认 'git'（在 env.PATH 里找）。 */
  gitPath: string;
  /** 子进程环境。应用里是登录 shell 的环境（见 docs/decisions.md）。 */
  env: NodeJS.ProcessEnv;
  /** 默认超时（毫秒）。 */
  timeoutMs: number;
}

export interface RunOptions {
  /** 写进 stdin，例如提交信息。 */
  input?: string;
  timeoutMs?: number;
  /** 这些退出码不算失败（git diff --no-index 有差异时退出 1）。 */
  okCodes?: readonly number[];
  /** 额外的环境变量。 */
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 大仓库的 diff、status 可能很长。 */
const MAX_BUFFER = 64 * 1024 * 1024;

/** git 失败：code 是 git-failed，detail 是它的原话（stderr，没有就 stdout）。 */
export class GitCommandError extends AgentDeckError {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;

  constructor(args: readonly string[], result: RunResult) {
    const detail = (result.stderr.trim() || result.stdout.trim()) || `git ${args[0] ?? ''} exited with code ${result.code}`;
    super({ code: 'git-failed', message: firstLine(detail), detail });
    this.exitCode = result.code;
    this.stderr = result.stderr;
    this.stdout = result.stdout;
  }
}

export function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? text;
  return line.replace(/^(fatal|error): /, '').trim();
}

export type Runner = (cwd: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>;

export function createRunner(opts: RunnerOptions): Runner {
  // 不让 git 弹出输入密码、不开分页器、不用编辑器；输出固定英文，解析才稳定。
  const baseEnv: NodeJS.ProcessEnv = {
    ...opts.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_EDITOR: 'true',
    LC_ALL: 'C',
    LANG: 'C',
  };

  return (cwd, args, runOpts = {}) =>
    new Promise<RunResult>((resolve, reject) => {
      const timeout = runOpts.timeoutMs ?? opts.timeoutMs;
      const child = execFile(
        opts.gitPath,
        // core.quotepath=false：非 -z 输出里的中文路径不转义
        ['-c', 'core.quotepath=false', ...args],
        {
          cwd,
          env: runOpts.env ? { ...baseEnv, ...runOpts.env } : baseEnv,
          timeout,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_BUFFER,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr, code: 0 });
            return;
          }
          const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: unknown };
          if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
            // 目录不存在时 node 也报 spawn ENOENT，分不清是 git 没装还是目录没了，看一眼目录
            reject(
              existsSync(cwd)
                ? new AgentDeckError({ code: 'command-not-found', message: `Couldn't run git (${opts.gitPath})`, detail: err.message })
                : new AgentDeckError({ code: 'not-found', message: `Folder not found: ${cwd}`, detail: err.message }),
            );
            return;
          }
          if (err.killed && err.signal) {
            const message = `git ${args[0] ?? ''} took longer than ${Math.round(timeout / 1000)}s`;
            reject(new AgentDeckError(stderr ? { code: 'timeout', message, detail: stderr } : { code: 'timeout', message }));
            return;
          }
          if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new AgentDeckError({ code: 'internal', message: 'git output too large', detail: err.message }));
            return;
          }
          const code = typeof err.code === 'number' ? err.code : 1;
          const result = { stdout, stderr, code };
          if (runOpts.okCodes?.includes(code)) resolve(result);
          else reject(new GitCommandError(args, result));
        },
      );
      if (runOpts.input !== undefined) child.stdin?.end(runOpts.input);
      else child.stdin?.end();
    });
}
