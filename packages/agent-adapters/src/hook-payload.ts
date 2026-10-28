// 把 claude / codex 钩子的原始负载转成 contracts 的 AgentHookEvent。
// 两边钩子的名字和负载基本一致（codex 的 hooks 就是照 claude 的格式做的），差别在各适配器里处理。
// 字段以本机实测为准：claude 2.1.291、codex 0.159.2，记录见 AGENTS.md「钩子实测」。

import type { AgentHookEvent, AgentSessionId } from '@agentdeck/contracts';

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** 给人看的一句话最多这么长。 */
const SUMMARY_MAX = 200;

function oneLine(text: string): string {
  const first = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  const more = text.trim().includes('\n') ? ' …' : '';
  const line = first + more;
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/**
 * 这些工具是在向用户提问，不是请求批准：进 needs-reply，永远不自动批准、不进 Approve all。
 * request_user_input 是 codex 的提问工具（还在开发中，没实测过它会不会走 PermissionRequest；万一走了也不能当批准）。
 */
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'request_user_input']);

/**
 * 编辑类工具：summary 写“Edit <路径>”，这样 `\.env` 一类的破坏性规则也能匹配到。
 * 小写的 edit、write 是 omp 的工具名（扩展把 tool_approval_requested 报成 PermissionRequest，参数是 { path, … }）。
 */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write']);

export function parseSessionStart(payload: unknown): AgentHookEvent | null {
  const id = str(obj(payload)?.session_id);
  return id ? { type: 'session-start', sessionId: id as AgentSessionId } : null;
}

export function parsePermissionRequest(payload: unknown): AgentHookEvent | null {
  const p = obj(payload);
  if (!p) return null;
  const tool = str(p.tool_name);
  const input = obj(p.tool_input) ?? {};
  if (tool && QUESTION_TOOLS.has(tool)) return { type: 'question', summary: questionSummary(tool, input) };
  const command = str(input.command);
  return { type: 'permission-request', tool, summary: approvalSummary(tool, input, command), command };
}

function questionSummary(tool: string, input: Json): string {
  if (tool === 'ExitPlanMode') return 'Approve the plan?';
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const first = str(obj(questions[0])?.question);
  return first ? oneLine(first) : 'Question';
}

function approvalSummary(tool: string | null, input: Json, command: string | null): string {
  if (command) return oneLine(command);
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  if (tool && FILE_TOOLS.has(tool) && path) return oneLine(`${tool} ${path}`);
  const url = str(input.url);
  if (url) return oneLine(`${tool ?? 'Fetch'} ${url}`);
  const description = str(input.description);
  if (description) return oneLine(description);
  return tool ?? 'Permission request';
}

/** claude 2.1.234 起额度续跑的通知（DR-84，按文档写的名字，待用真的 claude 撞一次额度核对）。 */
const QUOTA_RESUME = /^quota_auto_resume_(fired|stale|disabled)$/;

/**
 * claude 的 Notification：MCP 的 elicitation（在向你要输入）→ question；额度续跑（PL5）→ quota-resume：
 * fired 它自己开始续跑了，stale 睡过头、在等你按回车，disabled 用户关掉了 autoContinueAtUsageLimit（要 AgentDeck 来发）。
 * permission_prompt 已经由 PermissionRequest 处理。
 */
export function parseClaudeNotification(payload: unknown): AgentHookEvent | null {
  const p = obj(payload);
  if (p?.notification_type === 'elicitation_dialog') {
    return { type: 'question', summary: oneLine(str(p.message) ?? 'Input requested') };
  }
  const quota = QUOTA_RESUME.exec(str(p?.notification_type) ?? '');
  if (quota) return { type: 'quota-resume', what: quota[1] as 'fired' | 'stale' | 'disabled' };
  return null;
}

/**
 * claude 的 StopFailure（API 出错结束一轮）：带上 error，例如 "rate_limit"（额度用完，PL5 据此认出“这一轮是被额度结束的”）、
 * "server_error"。负载里没有 error 时只是 turn-end。
 */
export function parseClaudeStopFailure(payload: unknown): AgentHookEvent {
  const error = str(obj(payload)?.error);
  return error ? { type: 'turn-end', error } : { type: 'turn-end' };
}

/**
 * 两边共有的钩子。PostToolUse 映射成 prompt-submitted：它的意思是“agent 又在干活了”，
 * 用来在批准或回答之后离开 needs-approval / needs-reply（contracts 里没有更贴切的事件，见 CONTRACT_NOTES.md）。
 */
export function parseCommonHook(hookName: string, payload: unknown): AgentHookEvent | null {
  switch (hookName) {
    case 'SessionStart':
      return parseSessionStart(payload);
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return { type: 'prompt-submitted' };
    case 'PermissionRequest':
      return parsePermissionRequest(payload);
    case 'Stop':
      return { type: 'turn-end' };
    case 'SessionEnd':
      return { type: 'session-end' };
    default:
      return null;
  }
}

/**
 * PostToolUse 的负载和 PermissionRequest 一样带 tool_name、tool_input。算出同样的 summary，
 * 状态机用它判断跑完的是不是正在等批准的那个工具（见 status/machine.ts 第 8b 行）。
 */
export function hookHint(hookName: string, payload: unknown): { afterTool?: string | null } {
  if (hookName !== 'PostToolUse') return {};
  const e = parsePermissionRequest(payload);
  return { afterTool: e && (e.type === 'permission-request' || e.type === 'question') ? e.summary : null };
}
