// 从 agent 的 PostToolUse 钩子里认出它改了哪些文件（“谁改的”，DR-97）。
// claude：Write / Edit / MultiEdit / NotebookEdit 的 tool_input.file_path（或 notebook_path）。
// codex：apply_patch 的补丁正文里的 “*** Add File: / *** Update File: / *** Move to:” 行（负载形状没在真 codex 上核对过）。

import { isAbsolute, resolve } from 'node:path';
import type { AbsPath } from '@agentdeck/contracts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const PATCH_LINE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;

/** PostToolUse 负载里被写的文件（绝对路径）。别的钩子、认不出的负载返回空数组。 */
export function toolUsePaths(hookName: string, payload: unknown, cwd: AbsPath | null): AbsPath[] {
  if (hookName !== 'PostToolUse') return [];
  const p = obj(payload);
  const input = obj(p?.tool_input);
  if (!p || !input) return [];
  const base = str(p.cwd) ?? cwd;
  const found: string[] = [];
  for (const v of [input.file_path, input.notebook_path]) {
    const s = str(v);
    if (s) found.push(s);
  }
  for (const v of [input.patch, input.input, input.command]) {
    const raw = Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : str(v);
    if (raw?.includes('*** Begin Patch')) for (const m of raw.matchAll(PATCH_LINE)) found.push(m[1]!.trim());
  }
  const out: AbsPath[] = [];
  for (const f of found) {
    const abs = isAbsolute(f) ? f : base ? resolve(base, f) : null;
    if (abs && !out.includes(abs)) out.push(abs);
  }
  return out;
}
