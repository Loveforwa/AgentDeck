// agent 最后一条回复（contracts 0.1.22 的 AgentService.lastReply，CO4 的悬停提示；CrewService.result 也用这一段）。
// 读 agent 自己的会话记录（用量模块找到的那个文件）的结尾，找最后一条 agent 说的话；读不到退回屏幕最后几行。
// 只读：不写、不改 agent 的任何文件。字段以 2026-10-28 本机核对为准：
//   claude 2.1.291  type assistant、message.content 里的 text 块（同一条消息拆成好几行，message.id 相同）；子 agent（isSidechain）、
//                   claude 自己插的（model <synthetic>，例如额度用完的提示）不算
//   codex 0.164     event_msg task_complete 的 last_agent_message（一轮的最后一句）、response_item message role assistant 的
//                   output_text、event_msg item_completed AgentMessage 的 Text：取文件里最后出现的那一条
//   pi 0.83 / omp 18  type message、message.role assistant、content 里的 text 块
// kimi 的记录格式没核对，只走屏幕。

import { open } from 'node:fs/promises';
import type { AgentKind, AgentLastReply, IsoTime, TerminalHost, TerminalId } from '@agentdeck/contracts';
import { isoOf, obj, parseLine, str, type Json } from '../usage/types.ts';

/** 读得懂会话记录的 agent。 */
export const REPLY_AGENTS = ['claude', 'codex', 'pi', 'omp'] as const;

/** 从会话记录里读到的一条回复。 */
export interface TranscriptReply {
  text: string;
  at: IsoTime | null;
}

/** 默认读文件结尾多少字节：一条回复加上后面的工具记录，一般在几十 KB 以内。找不到时再读一次更大的（最多 TAIL_MAX）。 */
const TAIL_BYTES = 256 * 1024;
const TAIL_MAX = 4 * 1024 * 1024;
/** 屏幕退回时取最后多少行、留多少行。 */
const SCREEN_LINES = 60;
const SCREEN_KEEP = 20;

function texts(content: unknown, kinds: readonly string[]): string[] {
  if (typeof content === 'string') return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content) {
    const b = obj(c);
    const t = b && kinds.includes(String(b['type'])) ? str(b['text']) : null;
    if (t && t.trim()) out.push(t);
  }
  return out;
}

function claudeReply(lines: readonly Json[]): TranscriptReply | null {
  // 从后往前找最后一条有字的 assistant；同一条消息（message.id 相同）的几个 text 块按顺序拼起来
  let id: string | null = null;
  let parts: string[] = [];
  let at: IsoTime | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const j = lines[i]!;
    if (j['type'] !== 'assistant' || j['isSidechain'] === true || j['isApiErrorMessage'] === true) continue;
    const m = obj(j['message']);
    if (!m || m['model'] === '<synthetic>') continue;
    const mid = str(m['id']);
    const t = texts(m['content'], ['text']);
    if (id === null) {
      if (t.length === 0) continue;
      id = mid ?? '';
      parts = t;
      at = isoOf(j['timestamp']);
      if (!mid) break;
    } else if (mid === id) {
      parts = [...t, ...parts];
    } else {
      break;
    }
  }
  return id === null ? null : { text: parts.join('\n\n').trim(), at };
}

function codexReply(lines: readonly Json[]): TranscriptReply | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const j = lines[i]!;
    const p = obj(j['payload']);
    if (!p) continue;
    let text: string | null = null;
    if (j['type'] === 'event_msg' && p['type'] === 'task_complete') text = str(p['last_agent_message']);
    else if (j['type'] === 'response_item' && p['type'] === 'message' && p['role'] === 'assistant') text = texts(p['content'], ['output_text']).join('\n\n') || null;
    else if (j['type'] === 'event_msg' && p['type'] === 'item_completed') {
      const item = obj(p['item']);
      if (item?.['type'] === 'AgentMessage') text = texts(item['content'], ['Text', 'text']).join('\n\n') || null;
    }
    if (text?.trim()) return { text: text.trim(), at: isoOf(j['timestamp']) };
  }
  return null;
}

function piReply(lines: readonly Json[]): TranscriptReply | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const j = lines[i]!;
    const m = obj(j['message']);
    if (j['type'] !== 'message' || m?.['role'] !== 'assistant') continue;
    const t = texts(m['content'], ['text']);
    if (t.length > 0) return { text: t.join('\n\n').trim(), at: isoOf(j['timestamp']) ?? isoOf(m['timestamp']) };
  }
  return null;
}

/** 会话记录的若干行（按文件里的顺序）→ 最后一条回复。认不出、这个 agent 不支持为 null。 */
export function lastReplyFromLines(agent: AgentKind, raw: readonly string[]): TranscriptReply | null {
  const lines: Json[] = [];
  for (const l of raw) {
    const j = parseLine(l.endsWith('\r') ? l.slice(0, -1) : l);
    if (j) lines.push(j);
  }
  switch (agent) {
    case 'claude':
      return claudeReply(lines);
    case 'codex':
      return codexReply(lines);
    case 'pi':
    case 'omp':
      return piReply(lines);
    default:
      return null;
  }
}

/** 文件结尾 n 字节，按行切好（第一行可能是半行，丢掉；整个文件都读进来时不丢）。 */
async function tailLines(file: string, n: number): Promise<{ lines: string[]; whole: boolean }> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - n);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    return { lines: start > 0 ? lines.slice(1) : lines, whole: start === 0 };
  } finally {
    await fh.close();
  }
}

/** 读会话文件里最后一条回复（只读结尾）。文件不在、认不出为 null。 */
export async function readLastReply(agent: AgentKind, file: string, opts: { tailBytes?: number } = {}): Promise<TranscriptReply | null> {
  if (!(REPLY_AGENTS as readonly string[]).includes(agent)) return null;
  let n = opts.tailBytes ?? TAIL_BYTES;
  for (;;) {
    const got = await tailLines(file, n).catch(() => null);
    if (!got) return null;
    const reply = lastReplyFromLines(agent, got.lines);
    if (reply || got.whole || n >= TAIL_MAX) return reply;
    n = Math.min(n * 4, TAIL_MAX);
  }
}

/** 屏幕最后几行（已经是纯文本）→ 去掉结尾的空行，留最后 SCREEN_KEEP 行。什么都没有为 null。 */
export function replyFromScreenLines(lines: readonly string[]): string | null {
  const body = lines.map((l) => l.replace(/\s+$/, ''));
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const kept = body.slice(-SCREEN_KEEP);
  while (kept.length > 0 && kept[0] === '') kept.shift();
  return kept.length > 0 ? kept.join('\n') : null;
}

export interface LastReplyOptions {
  /** 这个终端的会话文件（UsageServiceImpl.sessionFile）。找不到为 null。 */
  sessionFile: (terminalId: TerminalId) => Promise<{ agent: AgentKind; file: string } | null>;
  /** 退回屏幕时用。终端不存在时它抛 not-found，原样抛出去。 */
  terminals: Pick<TerminalHost, 'lastLines'>;
}

/**
 * AgentService.lastReply 的实现：先读会话记录，读不到再看屏幕。
 * CrewService.result 读子 session 的结果时用同一个（crew-service 由组装方注入）。
 */
export function createLastReply(opts: LastReplyOptions): (terminalId: TerminalId) => Promise<AgentLastReply> {
  return async (terminalId) => {
    const found = await opts.sessionFile(terminalId).catch(() => null);
    if (found) {
      const reply = await readLastReply(found.agent, found.file);
      if (reply?.text) return { text: reply.text, source: 'transcript', at: reply.at };
    }
    const lines = await opts.terminals.lastLines(terminalId, SCREEN_LINES);
    return { text: replyFromScreenLines(lines), source: 'screen', at: null };
  };
}
