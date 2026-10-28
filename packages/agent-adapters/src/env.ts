// 检测安装用的小工具：按传入环境的 PATH 找命令、取版本号、拆命令行。
// 登录 shell 的环境由 apps/desktop 读出后通过构造参数传进来（docs/decisions.md），这里不自己读。

import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AbsPath } from '@agentdeck/contracts';

export type Env = Record<string, string>;
/** 环境可以随时变（用户在 Settings 里点 Refresh 前重新读了登录 shell），所以传函数。 */
export type EnvSource = () => Env;

/** 在 env.PATH 里找可执行文件；command 已经是绝对路径时只检查它本身。 */
export async function findExecutable(command: string, env: Env): Promise<AbsPath | null> {
  if (!command) return null;
  if (command.includes('/')) {
    return isAbsolute(command) && (await isExecutableFile(command)) ? command : null;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 运行 `<path> --version`，取输出里第一个 x.y.z。失败或超时返回 null。 */
export function readVersion(path: AbsPath, env: Env, args: string[] = ['--version'], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    // 退出码不看：有的程序打印版本后以非 0 退出，能从输出里认出版本号就算数。
    execFile(path, args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 }, (_err, stdout, stderr) => {
      const m = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(`${stdout ?? ''}\n${stderr ?? ''}`);
      resolve(m?.[1] ?? null);
    });
  });
}

/** 比较 x.y.z，忽略预发布后缀。a < b 返回负数。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split('.').map((n) => Number(n) || 0);
  const pb = b.split(/[-+]/)[0]!.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 版本够不够新。AH3（DR-60）：version 为 null（读不出版本）时**不再当作够新**，按没核对处理：
 * 给了 help（`--help` 的输出和这一项要带的参数）时看 help 里有没有这个参数，有才算；没给就算不够（不带可能让 agent 起不来的参数）。
 */
export function atLeast(version: string | null, min: string, help?: { text: string | null; flag: string } | null): boolean {
  if (version !== null) return compareVersions(version, min) >= 0;
  return !!help?.text && helpHasFlag(help.text, help.flag);
}

/**
 * `--help` 的输出里有没有这个参数（`--settings`、`-e`）或子命令（`resume`，写成 `command:resume`）。
 * 参数后面跟空格、逗号、=、<、[ 或行尾才算，免得 `--session` 认成 `--session-id`。
 */
export function helpHasFlag(help: string, flag: string): boolean {
  if (flag.startsWith('command:')) {
    const name = flag.slice('command:'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s+${name}(?:\\s|,|\\|)`, 'm').test(help);
  }
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,\\[(|])${esc}(?![\\w-])`, 'm').test(help);
}

/** 运行 `<path> --help`（或给的参数），返回输出（stdout + stderr，最多 256KB）。失败、超时返回 null。 */
export function readHelp(path: AbsPath, env: Env, args: string[] = ['--help'], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, args, { env, timeout: timeoutMs, maxBuffer: 256 * 1024 }, (_err, stdout, stderr) => {
      const out = `${stdout ?? ''}\n${stderr ?? ''}`;
      resolve(out.trim() ? out : null);
    });
  });
}

/** 可执行文件的修改时间（毫秒，IS-77：agent 自己升级后据此重读版本、作废缓存）。读不到为 null。 */
export async function fileStamp(path: string | null): Promise<number | null> {
  if (!path) return null;
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 按 shell 的规则拆一行命令（单引号、双引号、反斜杠），不做变量展开。
 * 自定义命令（'pnpm dev'、'gemini --yolo'）用它拆成 cmd + args。
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) cur += line[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** 给 sh 用的单引号转义：钩子配置里的命令字符串由 agent 交给 sh -c 执行。 */
export function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
