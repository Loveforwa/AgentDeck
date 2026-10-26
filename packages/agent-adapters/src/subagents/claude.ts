// claude 的后台子 agent（N10，DR-61）。实测（2026-10-26，claude 2.1.291，记录见 AGENTS.md「后台 agent 实测」）：
//   - SubagentStart 钩子：agent_id、agent_type（没有任务描述）。
//   - SubagentStop 钩子：agent_id、agent_type、agent_transcript_path、last_assistant_message；
//     Stop / SubagentStop 还带 background_tasks（[{ id, type: 'subagent', status, description, agent_type }]）。
//   - 后台 agent 做完时，claude 给主 agent 发一条 <task-notification>，走的是 UserPromptSubmit 钩子（prompt 就是这段文字）：
//     task-id、status（completed …）、usage 里的 subagent_tokens、duration_ms。所以 UserPromptSubmit 不一定是你发的消息。
//   - 记录：<会话文件去掉 .jsonl>/subagents/agent-<id>.jsonl（isSidechain、agentId），旁边 agent-<id>.meta.json：
//     { agentType, description, toolUseId, requestShape: 'background' | …, … }。
// 只读，不写 ~/.claude 里的任何东西。

import { basename, dirname, join } from 'node:path';
import type { TranscriptLine } from '@agentdeck/contracts';
import type { Json } from '../usage/types.ts';
import { num, obj, parseLine, str } from '../usage/types.ts';

/** 主对话记录旁边的子 agent 目录里，这个子 agent 的记录文件。 */
export function claudeSubagentFile(mainTranscript: string, agentId: string): string {
  return join(dirname(mainTranscript), basename(mainTranscript, '.jsonl'), 'subagents', `agent-${agentId}.jsonl`);
}

export function claudeSubagentMetaFile(transcript: string): string {
  return transcript.replace(/\.jsonl$/, '.meta.json');
}

export interface ClaudeSubagentMeta {
  agentType: string | null;
  description: string | null;
  background: boolean | null;
}

export function parseClaudeSubagentMeta(text: string): ClaudeSubagentMeta | null {
  let j: Json | null;
  try {
    j = obj(JSON.parse(text));
  } catch {
    return null;
  }
  if (!j) return null;
  const shape = str(j['requestShape']);
  return { agentType: str(j['agentType']), description: str(j['description']), background: shape ? shape === 'background' : null };
}

export interface ClaudeTaskNotification {
  agentId: string;
  /** 原样，例如 "completed"。 */
  status: string | null;
  tokens: number | null;
  durationMs: number | null;
}

/** UserPromptSubmit 的 prompt 是 claude 自己发的 <task-notification> 时解析出来，不是时返回 null。 */
export function parseClaudeTaskNotification(prompt: string): ClaudeTaskNotification | null {
  if (!prompt.trimStart().startsWith('<task-notification>')) return null;
  const tag = (name: string): string | null => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(prompt);
    return m ? m[1]!.trim() : null;
  };
  const agentId = tag('task-id');
  if (!agentId) return null;
  const n = (name: string): number | null => {
    const v = tag(name);
    return v !== null && /^\d+$/.test(v) ? Number(v) : null;
  };
  return { agentId, status: tag('status'), tokens: n('subagent_tokens'), durationMs: n('duration_ms') };
}

/** claude 自己插进主对话的提示（task-notification 之类），不是你发的消息。 */
export function isClaudeSyntheticPrompt(prompt: string): boolean {
  return /^\s*<(task-notification|system-reminder|local-command|command-name)/.test(prompt);
}

export interface ClaudeBackgroundTask {
  id: string;
  description: string | null;
  agentType: string | null;
  status: string | null;
}

/** 钩子负载里的 background_tasks（只要 type 为 subagent 的）。 */
export function parseClaudeBackgroundTasks(v: unknown): ClaudeBackgroundTask[] {
  let list = v;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: ClaudeBackgroundTask[] = [];
  for (const item of list) {
    const t = obj(item);
    const id = t && str(t['id']);
    if (!t || !id || (t['type'] !== undefined && t['type'] !== 'subagent')) continue;
    out.push({ id, description: str(t['description']), agentType: str(t['agent_type']), status: str(t['status']) });
  }
  return out;
}

/** 记录窗口里一行最多这么长；工具结果只留第一行。 */
const TEXT_MAX = 2000;
const RESULT_MAX = 200;
/** 最多留最近这么多行。 */
export const TRANSCRIPT_KEEP = 500;

function clip(text: string, max: number): string {
  const t = text.trimEnd();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function firstLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const first = lines[0]?.trim() ?? '';
  return lines.length > 1 ? `${first} …` : first;
}

/** 工具调用写成一行：“Bash pnpm test”、“Read src/a.ts”、“WebSearch beijing weather”。 */
export function toolLine(name: string, input: Json): string {
  const pick =
    str(input['command']) ??
    str(input['file_path']) ??
    str(input['notebook_path']) ??
    str(input['path']) ??
    str(input['url']) ??
    str(input['pattern']) ??
    str(input['query']) ??
    str(input['description']) ??
    str(input['prompt']);
  return pick ? `${name} ${clip(firstLine(pick), RESULT_MAX)}` : name;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = obj(c);
        return b && b['type'] === 'text' ? (str(b['text']) ?? '') : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** 一行一行喂子 agent 的记录，随时取当前的行、用了多少 token、最近一步。认不出的行跳过。 */
export class ClaudeTranscriptParser {
  private lines: TranscriptLine[] = [];
  private dropped = 0;
  private lastUsage: { id: string | null; tokens: number } | null = null;
  private step: string | null = null;

  feed(raw: string): void {
    const j = parseLine(raw);
    if (!j) return;
    const msg = obj(j['message']);
    if (!msg) return;
    if (j['type'] === 'user') {
      const content = msg['content'];
      if (typeof content === 'string') {
        if (content.trim()) this.push({ kind: 'prompt', text: clip(content, TEXT_MAX) });
        return;
      }
      if (!Array.isArray(content)) return;
      for (const c of content) {
        const b = obj(c);
        if (!b) continue;
        if (b['type'] === 'tool_result') {
          const text = firstLine(resultText(b['content']));
          const error = b['is_error'] === true;
          if (text || error) this.push({ kind: error ? 'error' : 'result', text: clip(text || 'Error', RESULT_MAX) });
        } else if (b['type'] === 'text') {
          const text = str(b['text']);
          if (text?.trim()) this.push({ kind: 'prompt', text: clip(text, TEXT_MAX) });
        }
      }
      return;
    }
    if (j['type'] !== 'assistant' || msg['model'] === '<synthetic>') return;
    const usage = obj(msg['usage']);
    if (usage) {
      const total =
        (num(usage['input_tokens']) ?? 0) +
        (num(usage['cache_read_input_tokens']) ?? 0) +
        (num(usage['cache_creation_input_tokens']) ?? 0) +
        (num(usage['output_tokens']) ?? 0);
      if (total > 0) this.lastUsage = { id: str(msg['id']), tokens: total };
    }
    const content = msg['content'];
    if (!Array.isArray(content)) return;
    for (const c of content) {
      const b = obj(c);
      if (!b) continue;
      if (b['type'] === 'tool_use') {
        const line = toolLine(str(b['name']) ?? 'Tool', obj(b['input']) ?? {});
        this.push({ kind: 'tool', text: line });
        this.step = line;
      } else if (b['type'] === 'text') {
        const text = str(b['text']);
        if (text?.trim()) {
          this.push({ kind: 'text', text: clip(text, TEXT_MAX) });
          this.step = clip(firstLine(text), RESULT_MAX);
        }
      }
    }
  }

  private push(line: TranscriptLine): void {
    this.lines.push(line);
    if (this.lines.length > TRANSCRIPT_KEEP) {
      const extra = this.lines.length - TRANSCRIPT_KEEP;
      this.lines.splice(0, extra);
      this.dropped += extra;
    }
  }

  snapshot(): { lines: TranscriptLine[]; omitted: number; tokens: number | null; lastStep: string | null } {
    return { lines: [...this.lines], omitted: this.dropped, tokens: this.lastUsage?.tokens ?? null, lastStep: this.step };
  }
}
