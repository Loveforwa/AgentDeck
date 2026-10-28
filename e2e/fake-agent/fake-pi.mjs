#!/usr/bin/env node
// 端到端测试用的假 pi / 假 omp（g3：TC-46、TC-48）。沙盒的包装脚本这样调：
//   node fake-pi.mjs --fake-as pi|omp --fake-version <x.y.z> -- <AgentDeck 给的参数…>
// 参数按真程序的规矩解析（agent-adapters/src/adapters/known.ts 的核对记录）：
//   pi  0.83：--session-id / --session / --fork / -e / --skill 带值，位置参数就是第一条消息（不认 `--`）；
//        @ 开头的位置参数是文件（找不到就退出，和真 pi 一样），所以 AgentDeck 在 @、- 开头的消息前加一个空格。
//   omp 18：-r/--resume / --fork / -e / --plugin-dir 带值，`--` 之后全是第一条消息（@、- 开头的也照原文）。
// -e 给的扩展（AgentDeck 的 agentdeck-pi-extension.mjs）真的 import 进来、按 pi 的扩展接口调（api.on(事件, (event, ctx) => …)），
// 所以 SessionStart / UserPromptSubmit / PermissionRequest / Stop 都是扩展经 agentdeck-notify 发出去的。
//
// 收到的第一条消息、之后打的每一行都记日志（kind: first-message / message，text 是原文），回答画在屏幕上：
// 消息里有 “reply with the word X” 时回答 X。
// omp 另外认 `ask [命令]`：扩展报 tool_call + tool_approval_requested（PermissionRequest），画 omp 18.0.4 的确认框
// （╭─ Allow tool: bash ─╮、Command: …、Approve / Deny），↑ ↓ 选、回车确定；按到的键都记日志（kind: key）。
// 日志：$AGENTDECK_E2E_LOG_DIR/<pi|omp>-<pid>.jsonl。

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger, readLines, write } from './fake-common.mjs';

const all = process.argv.slice(2);
const sep = all.indexOf('--');
const own = sep >= 0 ? all.slice(0, sep) : all;
const args = sep >= 0 ? all.slice(sep + 1) : [];
const as = own[own.indexOf('--fake-as') + 1] === 'omp' ? 'omp' : 'pi';
const version = own[own.indexOf('--fake-version') + 1] ?? (as === 'omp' ? '18.0.4' : '0.83.0');

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(as === 'omp' ? `omp/${version}\n` : `${version}\n`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    as === 'omp'
      ? 'Usage: omp [options] [-- message]\n  -r, --resume[=<id>]\n  -e, --extension <path>\n  --plugin-dir <dir>\n'
      : 'Usage: pi [options] [message]\n  --session-id <id>\n  --session <path|id>\n  --fork <path|id>\n  -e, --extension <path>\n  --skill <dir>\n',
  );
  process.exit(0);
}

const VALUE_FLAGS = as === 'omp' ? ['-r', '--resume', '--fork', '-e', '--extension', '--plugin-dir'] : ['--session-id', '--session', '--fork', '-e', '--extension', '--skill', '--append-system-prompt'];
/** @type {Record<string, string[]>} */
const flags = {};
const positional = [];
let message = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i] ?? '';
  if (as === 'omp' && a === '--') {
    message = args.slice(i + 1).join(' ');
    break;
  }
  if (VALUE_FLAGS.includes(a)) {
    (flags[a] ??= []).push(args[++i] ?? '');
    continue;
  }
  if (a.startsWith('-') && a.length > 1) {
    // 不认识的参数：照真 pi 的解析吃掉下一项当它的值
    (flags[a] ??= []).push(args[++i] ?? '');
    continue;
  }
  positional.push(a);
}
if (as === 'pi' && positional.length > 0) message = positional.join(' ');
// 真 pi：@ 开头的是文件，找不到就退出
if (as === 'pi') {
  for (const p of positional) {
    if (p.startsWith('@') && !existsSync(resolve(p.slice(1)))) {
      process.stderr.write(`Error: file not found: ${p.slice(1)}\n`);
      process.exit(1);
    }
  }
}

const sessionId =
  flags['--session-id']?.[0] ?? flags['--session']?.[0] ?? flags['--resume']?.[0] ?? flags['-r']?.[0] ?? randomUUID();
const log = logger(`${as}-${process.pid}`);
log({ kind: 'start', as, version, argv: args, message });

// ---- 扩展 ----
/** @type {Map<string, ((event: unknown, ctx: unknown) => void)[]>} */
const handlers = new Map();
const ctx = {
  sessionManager: { getSessionId: () => sessionId },
  getContextUsage: () => ({ tokens: 4200, contextWindow: 200_000, percent: 2.1 }),
  model: { id: 'fake-model' },
};
/** @param {string} name @param {Record<string, unknown>} [event] */
const fire = (name, event = {}) => {
  for (const h of handlers.get(name) ?? []) h(event, ctx);
};
const ext = flags['-e']?.[0] ?? flags['--extension']?.[0] ?? null;
if (ext) {
  try {
    const mod = await import(pathToFileURL(ext).href);
    mod.default({ on: (/** @type {string} */ name, /** @type {(event: unknown, ctx: unknown) => void} */ h) => handlers.set(name, [...(handlers.get(name) ?? []), h]) });
    log({ kind: 'extension-loaded', path: ext, events: [...handlers.keys()] });
  } catch (e) {
    log({ kind: 'extension-failed', error: String(e) });
  }
}

const turnEnd = () => (as === 'omp' ? fire('agent_end', { willContinue: false }) : (fire('agent_end'), fire('agent_settled')));
const prompt = () => write('\n> ');

/** @param {string} text @param {'first-message' | 'message'} kind */
function answer(text, kind) {
  log({ kind, text });
  fire('agent_start');
  write(`\n${as === 'omp' ? '●' : '>'} ${text}\n`);
  const word = /reply with the word (\w+)/i.exec(text)?.[1];
  write(`\n  ${word ?? 'OK'}\n`);
  fire('turn_end');
  turnEnd();
  prompt();
}

// ---- omp 的确认框 ----
/** @type {{ id: string, command: string, choice: 0 | 1 } | null} */
let approval = null;
let toolSeq = 0;
function drawApproval() {
  if (!approval) return;
  const width = Math.max(30, approval.command.length + 14);
  const line = (/** @type {string} */ s) => `│ ${s.padEnd(width - 4)} │`;
  write(
    `\n╭─ Allow tool: bash ${'─'.repeat(Math.max(1, width - 21))}╮\n` +
      `${line(`Command: ${approval.command}`)}\n` +
      `${line(`${approval.choice === 0 ? '❯' : ' '} Approve`)}\n` +
      `${line(`${approval.choice === 1 ? '❯' : ' '} Deny`)}\n` +
      `╰${'─'.repeat(width - 2)}╯\n`,
  );
}
function ask(/** @type {string} */ command) {
  const id = `call_${++toolSeq}`;
  log({ kind: 'ask', command });
  fire('agent_start');
  fire('tool_call', { toolName: 'bash', toolCallId: id, input: { command } });
  approval = { id, command, choice: 0 };
  fire('tool_approval_requested', { toolName: 'bash', toolCallId: id });
  drawApproval();
}
function resolveApproval() {
  if (!approval) return;
  const { id, command, choice } = approval;
  approval = null;
  const approved = choice === 0;
  log({ kind: approved ? 'approved' : 'denied', command });
  fire('tool_approval_resolved', { toolName: 'bash', toolCallId: id, approved });
  fire('tool_result', { toolName: 'bash', toolCallId: id });
  write(approved ? `  Ran ${command}\n` : '  Denied.\n');
  turnEnd();
  prompt();
}

write(`\x1b[1m${as === 'omp' ? 'Oh My Pi' : 'pi'} (AgentDeck e2e fake) v${version}\x1b[0m\n  session: ${sessionId}\n`);
fire('session_start');
let esc = '';
readLines({
  // 确认框里 ↑ ↓ 选、回车确定（方向键是 ESC [ A / B，一个字一个字到这里）
  onKey: (ch) => {
    if (!approval) return false;
    log({ kind: 'key', key: ch });
    esc = ch === '\x1b' ? ch : esc ? esc + ch : '';
    if (esc === '\x1b[A') {
      approval.choice = 0;
      esc = '';
    } else if (esc === '\x1b[B') {
      approval.choice = 1;
      esc = '';
    } else if (!esc && (ch === '\r' || ch === '\n')) resolveApproval();
    return true;
  },
  onLine: (l) => {
    if (approval) return;
    const t = l.trim();
    if (t === '') return prompt();
    if (as === 'omp' && /^ask\b/.test(t)) return ask(t.slice(3).trim() || 'ls -la');
    if (t === 'quit' || t === 'exit') {
      fire('session_shutdown');
      setTimeout(() => process.exit(0), 300);
      return;
    }
    answer(l, 'message');
  },
});
if (message !== null) answer(message, 'first-message');
else prompt();
