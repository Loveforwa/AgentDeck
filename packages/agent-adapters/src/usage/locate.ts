// 按会话 id（kimi 按目录和启动时间）找到各 agent 的会话文件。只读：readdir / stat / 读开头几 KB。

import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { claudeProjectDirName } from './claude.ts';
import { parseKimiIndex } from './kimi.ts';
import { num, parseLine } from './types.ts';

/** 各 agent 的数据目录。默认值见 defaultUsageRoots。 */
export interface UsageRoots {
  /** ~/.claude（$CLAUDE_CONFIG_DIR），下面有 projects/。 */
  claude: string;
  /** ~/.codex（$CODEX_HOME），下面有 sessions/。 */
  codex: string;
  /** ~/.pi/agent，下面有 sessions/。 */
  pi: string;
  /** ~/.omp/agent，下面有 sessions/。 */
  omp: string;
  /** ~/.kimi-code，下面有 sessions/、session_index.jsonl、config.toml。 */
  kimi: string;
}

export function defaultUsageRoots(home: string, env: Record<string, string | undefined> = {}): UsageRoots {
  return {
    claude: env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'),
    codex: env['CODEX_HOME'] || join(home, '.codex'),
    pi: env['PI_CODING_AGENT_DIR'] || join(home, '.pi', 'agent'),
    omp: join(home, '.omp', 'agent'),
    kimi: join(home, '.kimi-code'),
  };
}

export interface Located {
  file: string;
  match: 'exact' | 'inferred';
  sessionId: string | null;
}

/** 会话 id 只能是普通的名字，不能带路径分隔符（拼路径前检查）。 */
export function safeId(id: string | null | undefined): id is string {
  return !!id && /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function dirs(p: string): Promise<string[]> {
  try {
    return (await readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function files(p: string): Promise<string[]> {
  try {
    return (await readdir(p, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function mtime(p: string): Promise<number> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

// ---- claude ----

export async function locateClaude(
  root: string,
  q: { sessionId: string | null; cwd: string | null; transcriptPath?: string | null; scan?: boolean },
): Promise<Located | null> {
  const { sessionId } = q;
  // 钩子给的 transcript_path 最准（会话 id 对得上时）
  if (q.transcriptPath && (!sessionId || basename(q.transcriptPath) === `${sessionId}.jsonl`) && (await isFile(q.transcriptPath)))
    return { file: q.transcriptPath, match: 'exact', sessionId };
  if (!safeId(sessionId)) return null;
  const projects = join(root, 'projects');
  const name = `${sessionId}.jsonl`;
  if (q.cwd) {
    const cands = new Set([q.cwd]);
    const real = await realpath(q.cwd).catch(() => null);
    if (real) cands.add(real);
    for (const c of cands) {
      const p = join(projects, claudeProjectDirName(c), name);
      if (await isFile(p)) return { file: p, match: 'exact', sessionId };
    }
  }
  // 目录名对不上（路径太长被截断、cwd 变过）时扫一遍所有项目目录
  if (q.scan === false) return null;
  for (const d of await dirs(projects)) {
    const p = join(projects, d, name);
    if (await isFile(p)) return { file: p, match: 'exact', sessionId };
  }
  return null;
}

// ---- codex ----

/** sessions/YYYY/MM/DD/rollout-…-<id>.jsonl，从最新的日期往前找。 */
export async function locateCodex(root: string, sessionId: string | null): Promise<Located | null> {
  if (!safeId(sessionId)) return null;
  const sessions = join(root, 'sessions');
  const desc = (xs: string[]) => xs.filter((x) => /^\d+$/.test(x)).sort((a, b) => Number(b) - Number(a));
  for (const y of desc(await dirs(sessions)))
    for (const m of desc(await dirs(join(sessions, y))))
      for (const d of desc(await dirs(join(sessions, y, m)))) {
        const dir = join(sessions, y, m, d);
        const hits = (await files(dir)).filter((f) => f.startsWith('rollout-') && f.endsWith(`${sessionId}.jsonl`));
        if (hits.length === 0) continue;
        let best: string | null = null;
        let bestT = -1;
        for (const h of hits) {
          const t = await mtime(join(dir, h));
          if (t > bestT) [best, bestT] = [h, t];
        }
        if (best) return { file: join(dir, best), match: 'exact', sessionId };
      }
  return null;
}

// ---- pi / omp ----

/** sessions/<任意目录>/<时间>_<id>.jsonl，几个都对得上时取最近改过的。 */
export async function locatePi(root: string, sessionId: string | null): Promise<Located | null> {
  if (!safeId(sessionId)) return null;
  const sessions = join(root, 'sessions');
  let best: string | null = null;
  let bestT = -1;
  for (const d of await dirs(sessions)) {
    for (const f of await files(join(sessions, d))) {
      if (!f.endsWith(`_${sessionId}.jsonl`)) continue;
      const p = join(sessions, d, f);
      const t = await mtime(p);
      if (t > bestT) [best, bestT] = [p, t];
    }
  }
  return best ? { file: best, match: 'exact', sessionId } : null;
}

// ---- kimi ----

export interface KimiQuery {
  sessionId: string | null;
  cwd: string | null;
  /** 终端启动的时间（毫秒）。不知道时取这个目录里最近活动的会话。 */
  startedAt: number | null;
  /** 同一目录里其他 kimi 终端的启动时间：在它们之后建的会话归它们。 */
  peers: number[];
}

/**
 * 启动时间和会话创建时间的容差（时间来自两个进程，可能差一点）。
 * 会话归“启动时间 - 容差 <= 会话创建时间”的终端里启动最晚的那个；两个终端在容差内先后启动时分不清，这就是 inferred。
 */
const KIMI_SLACK_MS = 1500;

async function kimiCreatedAt(wire: string): Promise<number | null> {
  try {
    const fh = await open(wire, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const first = buf.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
      const d = parseLine(first);
      const t = d && d['type'] === 'metadata' ? num(d['created_at']) : null;
      if (t !== null) return t;
    } finally {
      await fh.close();
    }
    const st = await stat(wire);
    return st.birthtimeMs || st.ctimeMs;
  } catch {
    return null;
  }
}

async function samePath(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const [ra, rb] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return ra === rb;
}

export async function locateKimi(root: string, q: KimiQuery): Promise<Located | null> {
  let index;
  try {
    index = parseKimiIndex(await readFile(join(root, 'session_index.jsonl'), 'utf8'));
  } catch {
    return null;
  }
  const wireOf = (dir: string) => join(dir, 'agents', 'main', 'wire.jsonl');
  if (q.sessionId) {
    const e = index.find((x) => x.sessionId === q.sessionId || x.sessionId === `session_${q.sessionId}`);
    if (e && (await isFile(wireOf(e.sessionDir)))) return { file: wireOf(e.sessionDir), match: 'exact', sessionId: e.sessionId };
  }
  if (!q.cwd) return null;
  let best: { file: string; sessionId: string; t: number } | null = null;
  for (const e of index) {
    if (!(await samePath(e.workDir, q.cwd))) continue;
    const wire = wireOf(e.sessionDir);
    if (!(await isFile(wire))) continue;
    if (q.startedAt !== null) {
      const created = await kimiCreatedAt(wire);
      if (created === null || created < q.startedAt - KIMI_SLACK_MS) continue;
      // 比我们晚启动、又在这个会话之前启动的终端，这个会话归它
      if (q.peers.some((p) => p > q.startedAt! && p - KIMI_SLACK_MS <= created)) continue;
    }
    const t = await mtime(wire);
    if (!best || t > best.t) best = { file: wire, sessionId: e.sessionId, t };
  }
  return best ? { file: best.file, match: 'inferred', sessionId: best.sessionId } : null;
}
