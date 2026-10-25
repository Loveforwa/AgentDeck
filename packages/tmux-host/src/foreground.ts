// X6：shell 正在跑的命令（TerminalInfo.foregroundCommand）和恢复时填进输入行的字（CreateTerminalRequest.prefill）。
//
// 前台命令：窗格的进程（#{pane_pid}，Shell 窗口里就是 shell）所在终端的前台进程组（ps 的 tpgid）不是它自己时，
// shell 正在跑一条命令，取那个进程组组长的参数（ps -o args）。pane_current_command 只有进程名（pnpm dev 显示成 node），不够用；
// 读 shell 的历史文件分不清是哪个终端敲的，也不想往用户的 shell 配置里加钩子。
// 代价：参数里的引号丢了（ps 用空格连起来）；管道只看到第一段；跑得很短的命令（ls）等不到下次 list() 就结束了，记不到。

import { realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { findExecutable, type Env } from './env.ts';

/** 脚本经这些解释器运行时（shebang），ps 里看到的是 “node /opt/homebrew/bin/pnpm dev”，要还原成 “pnpm dev”。 */
const INTERPRETER_RE = /^(node|nodejs|bun|deno|python[0-9.]*|ruby|perl|php|bash|sh|zsh|dash|fish)$/;
const PS_TIMEOUT_MS = 2000;

export type PsRunner = (args: string[]) => Promise<string>;

export const runPs: PsRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('/bin/ps', args, { timeout: PS_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      // 有的 pid 已经不在时 ps 退出码是 1，但其余的照常输出
      if (err && !stdout) reject(err);
      else resolve(stdout);
    });
  });

/** `ps -o pid=,<col>=` 的输出 → pid → 那一列。 */
export function parsePsColumns(out: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.search(/\s/);
    const pid = Number(sp === -1 ? t : t.slice(0, sp));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    m.set(pid, sp === -1 ? '' : t.slice(sp).trim());
  }
  return m;
}

/**
 * 每个窗格进程（pid）的前台命令；在提示符下（前台进程组就是它自己）、取不到时不在结果里。
 * 两次 ps：先看每个窗格进程的 tpgid，再取那些前台进程组组长的参数。
 */
export async function foregroundCommands(pids: number[], env: Env, ps: PsRunner = runPs): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const live = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (live.length === 0) return out;
  let tpgids: Map<number, string>;
  try {
    tpgids = parsePsColumns(await ps(['-ww', '-o', 'pid=,tpgid=', '-p', live.join(',')]));
  } catch {
    return out;
  }
  const leaders = new Map<number, number>(); // 窗格进程 → 前台进程组组长
  for (const pid of live) {
    const tp = Number(tpgids.get(pid));
    if (Number.isInteger(tp) && tp > 0 && tp !== pid) leaders.set(pid, tp);
  }
  if (leaders.size === 0) return out;
  let args: Map<number, string>;
  try {
    args = parsePsColumns(await ps(['-ww', '-o', 'pid=,args=', '-p', [...new Set(leaders.values())].join(',')]));
  } catch {
    return out;
  }
  for (const [pid, leader] of leaders) {
    const a = args.get(leader);
    const cmd = a ? displayCommandLine(a, env) : '';
    if (cmd) out.set(pid, cmd);
  }
  return out;
}

/** ps 的 args → 给人看、能再敲一遍的命令行：解释器跑的脚本还原成脚本的命令名（它在 PATH 里能找到、而且是同一个文件时）。 */
export function displayCommandLine(args: string, env: Env, find: (name: string) => string | null = (n) => findExecutable(n, env)): string {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length >= 2 && INTERPRETER_RE.test(basename(tokens[0]!)) && tokens[1]!.startsWith('/')) {
    const script = tokens[1]!;
    const name = basename(script);
    const found = find(name);
    if (found && samePath(found, script)) return [name, ...tokens.slice(2)].join(' ');
  }
  return tokens.join(' ');
}

/** prefill 的字：控制字符（换行会让 shell 直接运行、Tab 会触发补全）换成空格。空的返回 null。 */
export function sanitizePrefill(text: string | undefined): string | null {
  if (!text) return null;
  const t = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t || null;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
