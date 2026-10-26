// 历史会话（N11，DR-62）：每种 agent 一个读取器，从一个会话文件里读出 SessionSummary 需要的东西。
// 只读文件开头（claude 还读结尾）几十到几百 KB，不读整个文件。字段以 2026-10-26 本机核对为准（DR-62）：
//   claude 2.1.291  ~/.claude/projects/<目录名>/<id>.jsonl：每行 cwd、gitBranch、timestamp、entrypoint；
//                   标题 custom-title（customTitle，/rename）> ai-title（aiTitle，写好几次取最后一个），都在结尾 64KB 里。
//   codex 0.164     ~/.codex/sessions/年/月/日/rollout-*-<id>.jsonl：第一行 session_meta（id、cwd、git.branch、source、originator）；
//                   标题在 ~/.codex/session_index.jsonl（thread_name），第一条消息在 history.jsonl 或文件里的 UserMessage。
//   pi 0.83 / omp 18  ~/.pi/agent/sessions、~/.omp/agent/sessions：第一行 session（id、cwd、timestamp）；omp 另有 title 行。
//   kimi 2.3        ~/.kimi-code/sessions/wd_*/session_<id>/state.json：id、cwd、title、lastPrompt、createdAt、updatedAt。

import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import type { SessionSource, SessionTitleKind } from '@agentdeck/contracts';
import { isoOf, obj, parseLine, str, type Json } from '../usage/types.ts';

/** 读取器读出来的（服务再补上 agent、文件、最后活动时间）。返回 null 表示不列（脚本跑的、子 agent、空会话）。 */
export interface ParsedSession {
  id: string;
  cwd: string | null;
  branch: string | null;
  title: string | null;
  titleKind: SessionTitleKind | null;
  firstPrompt: string | null;
  startedAt: string | null;
  source: SessionSource;
  model: string | null;
  /** kimi 自己记的最后活动时间；别的 agent 用文件的修改时间。 */
  updatedAt?: string | null;
}

const TITLE_MAX = 120;

/** 一行标题：第一行非空的，去掉多余空白，太长截掉。 */
export function oneLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const t = line.replace(/\s+/g, ' ');
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** 读文件开头 n 字节；size 比 n 大时另读结尾 n 字节。按行切好，第一行（结尾那段）可能是半行，丢掉。 */
export async function readHeadTail(file: string, n: number, withTail: boolean): Promise<{ head: string[]; tail: string[] }> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const headBuf = Buffer.alloc(Math.min(n, size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    const headText = headBuf.toString('utf8');
    // 开头读到的最后一行可能不完整（没读完）
    const head = size > n ? headText.split('\n').slice(0, -1) : headText.split('\n');
    if (!withTail || size <= n) return { head, tail: size <= n ? head : [] };
    const start = Math.max(n, size - n);
    const tailBuf = Buffer.alloc(size - start);
    await fh.read(tailBuf, 0, tailBuf.length, start);
    return { head, tail: tailBuf.toString('utf8').split('\n').slice(1) };
  } finally {
    await fh.close();
  }
}

/** claude 自己插的“用户消息”（命令输出、提醒、任务通知），不是你打的字。 */
function claudeSynthetic(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<') || t.startsWith('Caveat: The messages below');
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const b = obj(c);
      if (b && (b['type'] === 'text' || b['type'] === 'input_text')) {
        const t = str(b['text']);
        if (t) return t;
      }
    }
  }
  return null;
}

// ---- claude ----

export async function readClaudeSession(file: string): Promise<ParsedSession | null> {
  const { head, tail } = await readHeadTail(file, 64 * 1024, true);
  let cwd: string | null = null;
  let branch: string | null = null;
  let entrypoint: string | null = null;
  let startedAt: string | null = null;
  let firstPrompt: string | null = null;
  let custom: string | null = null;
  let ai: string | null = null;
  let model: string | null = null;
  const scan = (lines: string[], isHead: boolean) => {
    for (const raw of lines) {
      const j = parseLine(raw);
      if (!j) continue;
      if (isHead) {
        cwd = cwd ?? str(j['cwd']);
        branch = branch ?? str(j['gitBranch']);
        entrypoint = entrypoint ?? str(j['entrypoint']);
        startedAt = startedAt ?? isoOf(j['timestamp']);
        if (!firstPrompt && j['type'] === 'user' && j['isMeta'] !== true && j['isSidechain'] !== true) {
          const t = textOf(obj(j['message'])?.['content']);
          if (t && !claudeSynthetic(t)) firstPrompt = oneLine(t);
        }
      }
      if (j['type'] === 'custom-title') custom = str(j['customTitle']) ?? custom;
      if (j['type'] === 'ai-title') ai = str(j['aiTitle']) ?? ai;
      if (j['type'] === 'assistant') {
        const m = str(obj(j['message'])?.['model']);
        if (m && m !== '<synthetic>') model = m;
      }
    }
  };
  scan(head, true);
  if (tail !== head) scan(tail, false);
  const ep = entrypoint as string | null;
  // 脚本里跑的（claude -p、SDK）不列
  if (ep?.startsWith('sdk')) return null;
  const titleKind: SessionTitleKind | null = custom ? 'custom' : ai ? 'agent' : firstPrompt ? 'prompt' : null;
  if (!titleKind) return null; // 没说过话的空会话
  return {
    id: basename(file, '.jsonl'),
    cwd,
    branch,
    title: oneLine(custom ?? ai ?? firstPrompt),
    titleKind,
    firstPrompt,
    startedAt,
    source: ep === 'claude-desktop' ? 'desktop' : ep === 'cli' || ep === null ? 'terminal' : 'ide',
    model,
  };
}

// ---- codex ----

/** codex 的两个索引：会话名（session_index.jsonl）和你打过的字（history.jsonl，每个会话取第一条）。 */
export interface CodexIndex {
  names: Map<string, string>;
  prompts: Map<string, string>;
}

export function parseCodexIndex(sessionIndex: string, history: string): CodexIndex {
  const names = new Map<string, string>();
  for (const raw of sessionIndex.split('\n')) {
    const j = parseLine(raw);
    const id = j && str(j['id']);
    const name = j && str(j['thread_name']);
    if (id && name) names.set(id, name); // 后面的覆盖前面的（改过名）
  }
  const prompts = new Map<string, string>();
  for (const raw of history.split('\n')) {
    const j = parseLine(raw);
    const id = j && str(j['session_id']);
    const text = j && str(j['text']);
    if (id && text && !prompts.has(id)) prompts.set(id, text);
  }
  return { names, prompts };
}

const CODEX_DESKTOP = new Set(['Codex Desktop', 'codex_work_desktop']);

export async function readCodexSession(file: string, index: CodexIndex): Promise<ParsedSession | null> {
  // 第一行 session_meta 20–47KB；第一条用户消息在 200KB 左右（前面是系统提示），没有标题时才要它
  const { head } = await readHeadTail(file, 384 * 1024, false);
  const meta = obj(parseLine(head[0] ?? '')?.['payload']);
  if (!meta) return null;
  const source = meta['source'];
  // 子 agent（source 是对象）、脚本（exec、mcp）不列
  if (typeof source !== 'string' || source === 'exec' || source === 'mcp') return null;
  const id = str(meta['id']) ?? str(meta['session_id']);
  if (!id) return null;
  let firstPrompt = oneLine(index.prompts.get(id));
  let model: string | null = null;
  for (const raw of head.slice(1)) {
    if (!raw.includes('"thread_settings_applied"') && !raw.includes('"UserMessage"') && !raw.includes('"turn_context"')) continue;
    const p = obj(parseLine(raw)?.['payload']);
    if (!p) continue;
    if (p['type'] === 'thread_settings_applied') model = model ?? str(obj(p['thread_settings'])?.['model']);
    if (!model && str(p['model'])) model = str(p['model']);
    const item = obj(p['item']);
    if (!firstPrompt && item?.['type'] === 'UserMessage') firstPrompt = oneLine(textOf(item['content']));
    if (firstPrompt && model) break;
  }
  const name = index.names.get(id) ?? null;
  const titleKind: SessionTitleKind | null = name ? 'agent' : firstPrompt ? 'prompt' : null;
  if (!titleKind) return null;
  const originator = str(meta['originator']) ?? '';
  return {
    id,
    cwd: str(meta['cwd']),
    branch: str(obj(meta['git'])?.['branch']),
    title: oneLine(name ?? firstPrompt),
    titleKind,
    firstPrompt,
    startedAt: isoOf(meta['timestamp']),
    source: source === 'cli' ? 'terminal' : CODEX_DESKTOP.has(originator) ? 'desktop' : 'ide',
    model,
  };
}

// ---- pi / omp ----

export async function readPiSession(file: string): Promise<ParsedSession | null> {
  const { head, tail } = await readHeadTail(file, 64 * 1024, true);
  const first = parseLine(head[0] ?? '');
  if (!first || first['type'] !== 'session') return null;
  const id = str(first['id']);
  if (!id) return null;
  let firstPrompt: string | null = null;
  let model: string | null = null;
  let title: string | null = null;
  const scan = (lines: string[]) => {
    for (const raw of lines) {
      const j: Json | null = parseLine(raw);
      if (!j) continue;
      if (j['type'] === 'model_change') model = str(j['modelId']) ?? model;
      // omp：title 行（固定位置、后面补空格）和改名时的 title_change
      if (j['type'] === 'title' || j['type'] === 'title_change') title = str(j['title']) ?? title;
      if (!firstPrompt && j['type'] === 'message' && obj(j['message'])?.['role'] === 'user') {
        firstPrompt = oneLine(textOf(obj(j['message'])?.['content']));
      }
    }
  };
  scan(head);
  if (tail !== head) scan(tail);
  const titleKind: SessionTitleKind | null = title ? 'agent' : firstPrompt ? 'prompt' : null;
  if (!titleKind) return null;
  return {
    id,
    cwd: str(first['cwd']),
    branch: null,
    title: oneLine(title ?? firstPrompt),
    titleKind,
    firstPrompt,
    startedAt: isoOf(first['timestamp']),
    source: 'terminal',
    model,
  };
}

// ---- kimi ----

export function parseKimiState(text: string): ParsedSession | null {
  let j: Json | null;
  try {
    j = obj(JSON.parse(text));
  } catch {
    return null;
  }
  if (!j || j['archived'] === true) return null;
  const id = str(j['id']);
  if (!id) return null;
  const title = str(j['title']);
  const last = str(j['lastPrompt']);
  const titleKind: SessionTitleKind | null = title ? (j['isCustomTitle'] === true ? 'custom' : 'agent') : last ? 'prompt' : null;
  if (!titleKind) return null;
  const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : null);
  return {
    id,
    cwd: str(j['cwd']),
    branch: null,
    title: oneLine(title ?? last),
    titleKind,
    firstPrompt: null,
    startedAt: ms(j['createdAt']),
    updatedAt: ms(j['updatedAt']),
    source: 'terminal',
    model: null,
  };
}
