#!/usr/bin/env node
// 端到端测试用的假 claude（R2）。在测试的沙盒里以 `claude` 的名字放在 PATH 最前面，AgentDeck 把它当成真的 claude：
// 检测时 `claude --version` 报 2.1.291；启动时照真 claude 的参数（--session-id / --resume、--settings <json>）运行。
// 它不联网、不花 token，只做两件事：
//   1. 画一个像 TUI 的提示符，按键盘输入（经 xterm → tmux 送进来）切换状态；
//   2. 从 --settings 里取出 AgentDeck 注入的钩子命令（agentdeck-notify claude <事件>），在对应时机运行，负载走 stdin，
//      格式和真 claude 一样（session_id、tool_name、tool_input……）。
//
// 输入（在终端里打字，回车结束一行）：
//   work            → UserPromptSubmit，进入 running，一直干活，直到 done
//   ask [命令]       → UserPromptSubmit + PermissionRequest（Bash，默认命令 ls -la），屏幕上画确认框；
//                     等批准时按 1 或回车 = 允许一次 → PostToolUse，回到 running；按 2 或 Esc = 拒绝（和真 claude 一样不发钩子）
//   done            → Stop（一轮结束，idle）
//   quit / exit     → SessionEnd，退出码 0
//   crash           → 不发钩子，退出码 3（状态机记成 error）
// 每发一个钩子、每收到一次批准，都往 $AGENTDECK_E2E_LOG_DIR/<会话 id>.jsonl 写一行，测试读它核对后台发生了什么。
//
// 只用 node 内置模块。

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = '2.1.291';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ sessionId: string | null, resume: string | null, settings: any, prompt: string | null, version: boolean }} */
  const out = { sessionId: null, resume: null, settings: null, prompt: null, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--session-id') out.sessionId = argv[++i] ?? null;
    else if (a === '--resume') out.resume = argv[++i] ?? null;
    else if (a === '--settings') {
      try {
        out.settings = JSON.parse(argv[++i] ?? 'null');
      } catch {
        out.settings = null;
      }
    } else if (a === '--') {
      out.prompt = argv.slice(i + 1).join(' ') || null;
      break;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.version) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}

const sessionId = args.sessionId ?? args.resume ?? 'no-session';
const logDir = process.env['AGENTDECK_E2E_LOG_DIR'];
/** @param {Record<string, unknown>} entry */
function log(entry) {
  if (!logDir) return;
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ at: new Date().toISOString(), terminal: process.env['AGENTDECK_TERM'] ?? null, ...entry })}\n`,
    );
  } catch {
    // 日志只是给测试看的，写不了不影响假 agent
  }
}

/** @param {string} event */
function hookCommand(event) {
  const entry = args.settings?.hooks?.[event]?.[0]?.hooks?.[0];
  return typeof entry?.command === 'string' ? entry.command : null;
}

/** 钩子一个一个按顺序跑（真 claude 的钩子是同步的）。 */
let queue = Promise.resolve(/** @type {string} */ (''));
/**
 * @param {string} event
 * @param {Record<string, unknown>} [extra]
 * @returns {Promise<string>} 钩子的 stdout（PermissionRequest 时 AgentDeck 可能回 allow）
 */
function emitHook(event, extra = {}) {
  const payload = { session_id: sessionId, cwd: process.cwd(), hook_event_name: event, ...extra };
  const run = () =>
    new Promise((resolve) => {
      const command = hookCommand(event);
      log({ kind: 'hook', event, payload, wired: command !== null });
      if (!command) {
        resolve('');
        return;
      }
      const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(stdout));
      child.stdin.end(JSON.stringify(payload));
    });
  queue = queue.then(run, run);
  return /** @type {Promise<string>} */ (queue);
}

// ---- 画面 ----
const write = (/** @type {string} */ s) => process.stdout.write(s.replace(/\n/g, '\r\n'));
const PROMPT = '> ';

/** @type {'idle' | 'working' | 'approval'} */
let state = 'idle';
let line = '';
/** @type {{ tool_name: string, tool_input: { command: string } } | null} */
let pendingTool = null;

function prompt() {
  write(PROMPT);
}

function banner() {
  write('\x1b[1m* Fake Claude (AgentDeck e2e)\x1b[0m\n');
  write(`  cwd: ${process.cwd()}\n`);
  write(`  session: ${sessionId}${args.resume ? ' (resumed)' : ''}\n`);
  write('  commands: work · ask [cmd] · done · quit\n\n');
}

/** @param {string} command */
async function ask(command) {
  state = 'approval';
  pendingTool = { tool_name: 'Bash', tool_input: { command } };
  await emitHook('UserPromptSubmit', { prompt: `ask ${command}` });
  write(`\n● Bash(${command})\n`);
  write('  Do you want to proceed?\n  \x1b[7m❯ 1. Yes\x1b[0m\n    2. No\n');
  const out = await emitHook('PermissionRequest', { ...pendingTool, permission_mode: 'default' });
  if (/"behavior"\s*:\s*"allow"/.test(out)) {
    log({ kind: 'auto-approved', command });
    approve('hook');
  }
}

/** @param {string} how */
function approve(how) {
  if (state !== 'approval' || !pendingTool) return;
  const tool = pendingTool;
  pendingTool = null;
  state = 'working';
  log({ kind: 'approved', how, command: tool.tool_input.command });
  write(`  ✓ Allowed (${how})\n  Ran ${tool.tool_input.command}\n  Working…\n`);
  void emitHook('PostToolUse', { ...tool, tool_response: { stdout: '', stderr: '', interrupted: false } });
}

function deny() {
  if (state !== 'approval') return;
  pendingTool = null;
  state = 'idle';
  log({ kind: 'denied' });
  // 真 claude 拒绝后没有任何钩子（agent-adapters/AGENTS.md「钩子实测」），这里也不发
  write('  Interrupted · What should Claude do instead?\n');
  prompt();
}

/** @param {string} input */
async function runLine(input) {
  const [cmd = '', ...rest] = input.trim().split(/\s+/);
  switch (cmd) {
    case '':
      prompt();
      return;
    case 'work':
      state = 'working';
      await emitHook('UserPromptSubmit', { prompt: input });
      write('  Working… (type done to finish)\n');
      return;
    case 'ask':
      await ask(rest.join(' ') || 'ls -la');
      return;
    case 'done':
      state = 'idle';
      await emitHook('Stop', { stop_hook_active: false });
      write('  Done.\n');
      prompt();
      return;
    case 'crash':
      log({ kind: 'exit', reason: 'crash' });
      write('  Crashed.\n');
      process.exit(3);
      return;
    case 'quit':
    case 'exit':
      await emitHook('SessionEnd', { reason: 'prompt_input_exit' });
      log({ kind: 'exit' });
      process.exit(0);
      return;
    default:
      write(`  Unknown command: ${cmd}\n`);
      prompt();
  }
}

/** @param {string} chunk */
function onInput(chunk) {
  for (const ch of chunk) {
    if (state === 'approval') {
      if (ch === '1' || ch === '\r' || ch === 'y') approve('key');
      else if (ch === '2' || ch === '\x1b' || ch === 'n') deny();
      continue;
    }
    if (ch === '\x03') {
      log({ kind: 'exit', reason: 'ctrl-c' });
      process.exit(130);
    } else if (ch === '\r' || ch === '\n') {
      const input = line;
      line = '';
      write('\n');
      log({ kind: 'input', line: input });
      void runLine(input);
    } else if (ch === '\x7f' || ch === '\b') {
      if (line.length > 0) {
        line = line.slice(0, -1);
        write('\b \b');
      }
    } else if (ch >= ' ') {
      line += ch;
      write(ch);
    }
  }
}

banner();
log({ kind: 'start', argv: process.argv.slice(2).filter((a) => !a.startsWith('{')), resume: args.resume });
void emitHook('SessionStart', { source: args.resume ? 'resume' : 'startup' }).then(() => {
  if (args.prompt) void runLine(args.prompt);
  else prompt();
});
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => onInput(String(c)));
process.stdin.on('end', () => process.exit(0));
