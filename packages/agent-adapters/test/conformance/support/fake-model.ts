// L2 用的本地假模型（OpenAI 兼容的 /v1/chat/completions，流式和非流式都行），pi、omp、kimi 接它，不用账号、不花钱。
// 按最后一条用户消息里的话决定怎么回（只认这几句，其余回 OK）：
//   “reply with the word X”         → 回 X
//   “what was the word”             → 在整段对话里找最早的 “reply with the word X”，回 X（resume、fork 之后能答出来说明对话接上了）
//   “run the command: <命令>”        → 调 shell 工具（工具名在请求的 tools 里找：bash / shell），工具结果回来后回 done
//   “ask me a question”             → 调提问工具（ask），回答回来后回 thanks
//   “think slowly”                  → 30 秒后才回（K7 测 Esc 打断）
// 每个请求记在 requests 里（测试看第一条消息是不是原文送到）。

import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Msg {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
}
interface Tool {
  type?: string;
  function?: { name?: string; parameters?: { properties?: Record<string, unknown>; required?: string[] } };
}

export interface FakeModel {
  url: string;
  requests: { messages: Msg[]; tools: Tool[] }[];
  /** 所有请求里用户说过的话（去掉 agent 自己加的 <system-reminder> 之类）。 */
  userTexts(): string[];
  close(): Promise<void>;
}

const text = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((p) => (typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('')
      : '';

const strip = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<\/?user>/g, '').trim();

export async function startFakeModel(): Promise<FakeModel> {
  const requests: FakeModel['requests'] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
        return;
      }
      let j: { messages?: Msg[]; tools?: Tool[]; stream?: boolean } = {};
      try {
        j = JSON.parse(body) as typeof j;
      } catch {
        // 不是 JSON
      }
      const messages = j.messages ?? [];
      const tools = j.tools ?? [];
      requests.push({ messages, tools });
      const reply = decide(messages, tools);
      const send = () => respond(res, reply, j.stream === true);
      if (reply.delayMs) {
        const t = setTimeout(send, reply.delayMs);
        req.on('close', () => clearTimeout(t));
      } else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    userTexts: () => requests.flatMap((r) => r.messages.filter((m) => m.role === 'user').map((m) => strip(text(m.content)))).filter(Boolean),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

interface Reply {
  content: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  delayMs?: number;
}

const TRIGGERS = [/what was the word/i, /reply with the word \w+/i, /run the command: /i, /ask me a question/i, /think slowly/i];

function decide(messages: Msg[], tools: Tool[]): Reply {
  const last = messages.at(-1);
  if (last?.role === 'tool') {
    const asked = messages.some((m) => m.role === 'assistant' && JSON.stringify(m.tool_calls ?? '').includes('"ask'));
    return { content: asked ? 'thanks' : 'done' };
  }
  const users = messages.filter((m) => m.role === 'user').map((m) => strip(text(m.content)));
  // 这一轮用户说的话：最后一条助手消息之后的用户消息（kimi 会在用户的话后面再附一条提醒），从后往前找认得的那句
  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
  const turn = messages.slice(lastAssistant + 1).filter((m) => m.role === 'user').map((m) => strip(text(m.content)));
  const said = [...turn].reverse().find((t) => TRIGGERS.some((r) => r.test(t))) ?? turn.at(-1) ?? '';
  const all = users.join('\n');
  const word = /reply with the word (\w+)/i;
  if (/what was the word/i.test(said)) return { content: word.exec(all)?.[1] ?? 'I do not know' };
  const w = word.exec(said);
  if (w) return { content: w[1]! };
  const cmd = /run the command: (.+)$/im.exec(said);
  if (cmd) {
    const tool = tools.find((t) => /^(bash|shell)$/i.test(t.function?.name ?? ''));
    if (tool) return { content: '', toolCall: { name: tool.function!.name!, args: fillArgs(tool, { command: cmd[1]!.trim() }) } };
  }
  if (/ask me a question/i.test(said)) {
    const tool = tools.find((t) => /^ask/i.test(t.function?.name ?? ''));
    if (tool) return { content: '', toolCall: { name: tool.function!.name!, args: askArgs(tool) } };
  }
  if (/think slowly/i.test(said)) return { content: 'finally', delayMs: 30_000 };
  return { content: 'OK' };
}

/** 按工具的参数表补上必填项（只认 command、timeout 这类简单的）。 */
function fillArgs(tool: Tool, base: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const k of tool.function?.parameters?.required ?? []) {
    if (k in out) continue;
    if (/timeout/i.test(k)) out[k] = 30;
    else if (/description|reason/i.test(k)) out[k] = 'conformance probe';
    else out[k] = '';
  }
  return out;
}

/** omp 的 ask 工具：questions 数组（question、options）或单个 question，按参数表猜。 */
function askArgs(tool: Tool): Record<string, unknown> {
  const props = tool.function?.parameters?.properties ?? {};
  const q = { id: 'color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] };
  if ('questions' in props) return { questions: [q] };
  return { question: q.question, options: q.options };
}

function respond(res: ServerResponse, r: Reply, stream: boolean): void {
  const usage = { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 };
  const toolCalls = r.toolCall
    ? [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: r.toolCall.name, arguments: JSON.stringify(r.toolCall.args) } }]
    : undefined;
  const finish = toolCalls ? 'tool_calls' : 'stop';
  const base = { id: 'chatcmpl-fake', created: Math.floor(Date.now() / 1000), model: 'fake-model' };
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ...base,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: r.content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
        usage,
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta: object, finish_reason: string | null, extra: object = {}) =>
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
  chunk({ role: 'assistant', content: r.content }, null);
  if (toolCalls) chunk({ tool_calls: toolCalls }, null);
  chunk({}, finish, { usage });
  res.end('data: [DONE]\n\n');
}
