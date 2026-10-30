// 管理面板（MP2）开着的 agent 一行悬停提示里的“最后一条回复”（CO4 的 Agents 视图搬过来）。
//
// 需求是和 `agentdeck session result`（CrewService.result，C7）用同一段读会话记录的代码，读不到再退回屏幕最后几行。
// contracts 0.1.22 有了 agents.lastReply（agent-adapters 读 claude、codex、pi、omp 的会话记录）：组装方传 agentReplyReader(api)，
// 读到会话记录就用它；没有这个方法（假实现、老版本）或只读到屏幕时，走下面认屏幕的那条路：terminals.lastLines 取屏幕最后几十行，
// 认出 agent 最后一段回复（claude 的 ⏺ / ●、codex 的 •），去掉输入框和底栏；认不出就给最后几行。默认（不传 lastReply）只认屏幕。

import type { AgentDeckApi, TerminalId } from '@agentdeck/contracts';

export interface LastReply {
  text: string;
  /** transcript：读的会话记录；screen：屏幕上认出来的。和 CrewService.result 的 source 一样。 */
  source: 'transcript' | 'screen';
  /** reply：认出了 agent 的最后一段回复；lines：认不出，只是屏幕最后几行（提示里写 “On screen”）。 */
  kind: 'reply' | 'lines';
}

/** 按终端取最后一条回复。读不到为 null。 */
export type LastReplyReader = (terminalId: TerminalId) => Promise<LastReply | null>;

/** 取屏幕最后多少行来找回复。 */
export const SCREEN_LINES = 60;
/** 提示里最多几行、几个字。 */
const MAX_LINES = 8;
const MAX_CHARS = 600;
/** 认不出回复时给最后几行。 */
const TAIL_LINES = 4;
/** 输入框、底栏只在屏幕最下面这么多行里找。 */
const CHROME_LINES = 14;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** 行首行尾的框线（│ … │）。 */
const BORDER = /^[\s│┃]+|[\s│┃]+$/g;
/** 一整行横线（输入框的上下边）。 */
const RULE = /^[\s╭╮╰╯┌┐└┘├┤─━═]{8,}$/;
/** 输入行：›、❯、> 开头。 */
const PROMPT = /^\s*[│┃]?\s*[›❯>](\s|$)/;
/** 一段回复的开头：claude 的 ⏺ / ●，codex 的 •。 */
const REPLY = /^\s*[⏺●•]\s+/;

function cleanLine(line: string): string {
  return line.replace(ANSI, '').replace(/\s+$/, '');
}

/** 输入框（和它下面的底栏）从第几行开始；没有输入框时是 lines.length。 */
function chromeStart(lines: readonly string[]): number {
  const from = Math.max(0, lines.length - CHROME_LINES);
  let firstRule = -1;
  for (let i = lines.length - 1; i >= from; i--) {
    if (RULE.test(lines[i]!)) firstRule = i;
  }
  if (firstRule >= 0) return firstRule;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    if (PROMPT.test(lines[i]!)) return i;
  }
  return lines.length;
}

function clip(lines: string[]): string {
  const kept = lines.slice(0, MAX_LINES);
  let text = kept.join('\n');
  const more = lines.length > kept.length;
  if (text.length > MAX_CHARS) return `${text.slice(0, MAX_CHARS - 1).trimEnd()}…`;
  if (more) text = `${text}…`;
  return text;
}

/** 屏幕最后几行 → 最后一条回复。什么都没有时为 null。 */
export function replyFromScreen(raw: readonly string[]): LastReply | null {
  const lines = raw.map(cleanLine);
  const body = lines
    .slice(0, chromeStart(lines))
    .filter((l) => !RULE.test(l))
    .map((l) => l.replace(BORDER, ''));
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
  if (body.length === 0) return null;

  let start = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (REPLY.test(body[i]!)) {
      start = i;
      break;
    }
  }
  if (start >= 0) {
    const reply = body.slice(start).map((l, i) => (i === 0 ? l.replace(REPLY, '') : l.trim()));
    // 空行合成一个
    const compact = reply.filter((l, i) => l !== '' || (i > 0 && reply[i - 1] !== ''));
    return { text: clip(compact), source: 'screen', kind: 'reply' };
  }
  const tail = body.filter((l) => l.trim() !== '').slice(-TAIL_LINES).map((l) => l.trim());
  return tail.length > 0 ? { text: clip(tail), source: 'screen', kind: 'lines' } : null;
}

/** 会话记录里的一段回复 → 提示里的样子（空行合成一个，最多 8 行 600 字）。 */
export function replyFromTranscript(text: string): LastReply | null {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const compact = lines.filter((l, i) => l !== '' || (i > 0 && lines[i - 1] !== ''));
  while (compact.length > 0 && compact[0] === '') compact.shift();
  while (compact.length > 0 && compact[compact.length - 1] === '') compact.pop();
  return compact.length > 0 ? { text: clip(compact), source: 'transcript', kind: 'reply' } : null;
}

/**
 * contracts 0.1.22：先问 agents.lastReply（读会话记录）；没有这个方法、出错、只读到屏幕时，用 screenReplyReader 认屏幕。
 * 终端不存在时屏幕那一步会失败，交给调用方（提示里不写回复）。
 */
export function agentReplyReader(api: Pick<AgentDeckApi, 'terminals' | 'agents'>): LastReplyReader {
  const screen = screenReplyReader(api);
  return async (terminalId) => {
    const r = api.agents.lastReply ? await api.agents.lastReply(terminalId).catch(() => null) : null;
    if (r?.source === 'transcript' && r.text) {
      const reply = replyFromTranscript(r.text);
      if (reply) return reply;
    }
    return screen(terminalId);
  };
}

/** 默认的读法：屏幕最后几行（terminals.lastLines）。 */
export function screenReplyReader(api: Pick<AgentDeckApi, 'terminals'>): LastReplyReader {
  return async (terminalId) => replyFromScreen(await api.terminals.lastLines(terminalId, SCREEN_LINES));
}
