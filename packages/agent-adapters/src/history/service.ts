// HistoryService（MVP v3 · N11，画板 14，DR-62）：列出这台电脑上各 agent 的历史会话。
//
//   list() → 每种 agent 找出会话文件（readdir，claude 只看 projects/*/，不进子 agent 的 subagents/）
//   → 按“路径 + 修改时间 + 大小”缓存，只重读改过的（readers.ts，只读开头 / 结尾）
//   → 去掉不列的（脚本跑的、子 agent、空会话），最后活动的在前
//
// 第一次扫全机（本机 1200 多个文件）不到半秒。只读，不写、不删 agent 的任何文件。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentKind, AgentSessionId, HistoryService, SessionSummary } from '@agentdeck/contracts';
import type { UsageRoots } from '../usage/locate.ts';
import { parseCodexIndex, parseKimiState, readClaudeSession, readCodexSession, readPiSession, type CodexIndex, type ParsedSession } from './readers.ts';

export interface HistoryServiceOptions {
  roots: UsageRoots;
  /** 同时读几个文件，默认 16。 */
  concurrency?: number;
}

interface Cached {
  key: string;
  parsed: ParsedSession | null;
}

interface Found {
  agent: AgentKind;
  file: string;
  mtimeMs: number;
  size: number;
}

async function entries(dir: string): Promise<{ name: string; dir: boolean; file: boolean }[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }));
  } catch {
    return [];
  }
}

async function statOf(file: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await stat(file);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

export class HistoryServiceImpl implements HistoryService {
  private readonly cache = new Map<string, Cached>();
  private codexIndex: { key: string; index: CodexIndex } | null = null;
  private running: Promise<SessionSummary[]> | null = null;

  constructor(private readonly opts: HistoryServiceOptions) {}

  list(): Promise<SessionSummary[]> {
    // 同时来的几次请求共用一次扫描
    this.running ??= this.scan().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async scan(): Promise<SessionSummary[]> {
    const found = (await Promise.all([this.findClaude(), this.findCodex(), this.findPi('pi'), this.findPi('omp'), this.findKimi()])).flat();
    const index = await this.loadCodexIndex();
    const seen = new Set<string>();
    const out: SessionSummary[] = [];
    const queue = [...found];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        seen.add(f.file);
        const key = `${f.mtimeMs}:${f.size}:${f.agent === 'codex' ? index.key : ''}`;
        let c = this.cache.get(f.file);
        if (!c || c.key !== key) {
          c = { key, parsed: await this.read(f, index.index).catch(() => null) };
          this.cache.set(f.file, c);
        }
        if (!c.parsed) continue;
        const p = c.parsed;
        out.push({
          agent: f.agent,
          id: p.id as AgentSessionId,
          cwd: p.cwd,
          branch: p.branch,
          title: p.title ?? 'Untitled session',
          titleKind: p.titleKind,
          firstPrompt: p.firstPrompt,
          startedAt: p.startedAt,
          updatedAt: p.updatedAt ?? new Date(f.mtimeMs).toISOString(),
          source: p.source,
          model: p.model,
          file: f.file,
        });
      }
    };
    await Promise.all(Array.from({ length: this.opts.concurrency ?? 16 }, worker));
    // 删掉的文件不留在缓存里
    for (const file of this.cache.keys()) if (!seen.has(file)) this.cache.delete(file);
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  private read(f: Found, index: CodexIndex): Promise<ParsedSession | null> {
    switch (f.agent) {
      case 'claude':
        return readClaudeSession(f.file);
      case 'codex':
        return readCodexSession(f.file, index);
      case 'pi':
      case 'omp':
        return readPiSession(f.file);
      case 'kimi':
        return readText(f.file).then(parseKimiState);
      default:
        return Promise.resolve(null);
    }
  }

  private async withStat(agent: AgentKind, files: string[]): Promise<Found[]> {
    const out: Found[] = [];
    await Promise.all(
      files.map(async (file) => {
        const st = await statOf(file);
        if (st) out.push({ agent, file, ...st });
      }),
    );
    return out;
  }

  /** ~/.claude/projects/<目录名>/<id>.jsonl。不进 <id>/subagents/。 */
  private async findClaude(): Promise<Found[]> {
    const root = join(this.opts.roots.claude, 'projects');
    const files: string[] = [];
    for (const d of await entries(root)) {
      if (!d.dir) continue;
      for (const e of await entries(join(root, d.name))) if (e.file && e.name.endsWith('.jsonl')) files.push(join(root, d.name, e.name));
    }
    return this.withStat('claude', files);
  }

  /** ~/.codex/sessions/年/月/日/rollout-*.jsonl。 */
  private async findCodex(): Promise<Found[]> {
    const root = join(this.opts.roots.codex, 'sessions');
    const files: string[] = [];
    const walk = async (dir: string, depth: number) => {
      for (const e of await entries(dir)) {
        if (e.dir && depth < 3) await walk(join(dir, e.name), depth + 1);
        else if (e.file && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(join(dir, e.name));
      }
    };
    await walk(root, 0);
    return this.withStat('codex', files);
  }

  /** ~/.pi/agent/sessions/<目录名>/*.jsonl（omp 同样）。 */
  private async findPi(agent: 'pi' | 'omp'): Promise<Found[]> {
    const root = join(this.opts.roots[agent], 'sessions');
    const files: string[] = [];
    for (const d of await entries(root)) {
      if (!d.dir) continue;
      for (const e of await entries(join(root, d.name))) if (e.file && e.name.endsWith('.jsonl')) files.push(join(root, d.name, e.name));
    }
    return this.withStat(agent, files);
  }

  /** ~/.kimi-code/sessions/wd_*\/session_*\/state.json。 */
  private async findKimi(): Promise<Found[]> {
    const root = join(this.opts.roots.kimi, 'sessions');
    const files: string[] = [];
    for (const d of await entries(root)) {
      if (!d.dir || !d.name.startsWith('wd_')) continue;
      for (const s of await entries(join(root, d.name))) if (s.dir && s.name.startsWith('session_')) files.push(join(root, d.name, s.name, 'state.json'));
    }
    return this.withStat('kimi', files);
  }

  /** codex 的会话名和第一条消息（两个文件改了才重读）。 */
  private async loadCodexIndex(): Promise<{ key: string; index: CodexIndex }> {
    const a = join(this.opts.roots.codex, 'session_index.jsonl');
    const b = join(this.opts.roots.codex, 'history.jsonl');
    const [sa, sb] = await Promise.all([statOf(a), statOf(b)]);
    const key = `${sa?.mtimeMs ?? 0}:${sa?.size ?? 0}/${sb?.mtimeMs ?? 0}:${sb?.size ?? 0}`;
    if (this.codexIndex?.key === key) return this.codexIndex;
    const [ta, tb] = await Promise.all([readText(a), readText(b)]);
    this.codexIndex = { key, index: parseCodexIndex(ta, tb) };
    return this.codexIndex;
  }
}
