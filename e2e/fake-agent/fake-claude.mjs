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
//   done [回复]      → Stop（一轮结束，idle）；带回复时像真 claude 一样画一行 “● 回复”（CO4 的最后一条回复从屏幕上认它）
//   limit <秒> [noauto] → 像真 claude 撞上 5 小时额度（PL6）：会话记录里写一行 error "rate_limit"（quotaLimits.resetsAt = 现在 + 秒），
//                     发 StopFailure（error: rate_limit，带 transcript_path），回到 idle，画 “Usage limit reached”。
//                     默认像 claude 2.1.234 起那样自己续：到了恢复时间发 Notification quota_auto_resume_fired，再发 UserPromptSubmit
//                     接着干活（running）；等的时候你发来的一行（AgentDeck 送进来的改过的话）先记着，到点改发这一行、不发自己的 continue
//                     （DR-84 说真 claude 这样，待核对）。noauto：像用户关了 autoContinueAtUsageLimit，马上发 quota_auto_resume_disabled，
//                     之后收到的一行当成普通的提示词（UserPromptSubmit，running）。
//   clear           → SessionStart（source: clear），换一个新的会话 id（和真 claude 的 /clear 一样）
//   compact         → SessionStart（source: compact），会话 id 不变
//   quit / exit     → SessionEnd，退出码 0
//   crash           → 不发钩子，退出码 3（状态机记成 error）
// 每发一个钩子、每收到一次批准，都往 $AGENTDECK_E2E_LOG_DIR/<会话 id>.jsonl 写一行，测试读它核对后台发生了什么。
//
// 只用 node 内置模块。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
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

/** 现在的会话 id：/clear 以后换新的。日志文件一直用启动时那个（logId）。 */
let sessionId = args.sessionId ?? args.resume ?? 'no-session';
const logId = sessionId;
const logDir = process.env['AGENTDECK_E2E_LOG_DIR'];
/** @param {Record<string, unknown>} entry */
function log(entry) {
  if (!logDir) return;
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, `${logId}.jsonl`),
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
/**
 * 撞上额度以后在等（limit 命令）：self 为 true 时到点自己续；pending 是等的时候收到的一行（到点改发它）。
 * @type {{ self: boolean, resetsAt: number, pending: string | null, timer: ReturnType<typeof setTimeout> | null } | null}
 */
let limited = null;
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
  write('  commands: work · ask [cmd] · done · clear · compact · quit\n\n');
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

/** 会话记录（真 claude 的位置：$CLAUDE_CONFIG_DIR 或 ~/.claude 下 projects/<cwd 里非字母数字换成 -> /<会话 id>.jsonl）。 */
function transcriptPath() {
  const root = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
  return join(root, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/** 像真 claude 那样撞上额度（PL6 的 e2e 用）。 */
async function hitLimit(/** @type {string[]} */ rest) {
  const secs = Math.max(1, Number(rest[0]) || 60);
  const self = !rest.includes('noauto');
  const resetsAt = Date.now() + secs * 1000;
  const file = transcriptPath();
  const reset = new Date(resetsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const line = {
      type: 'assistant',
      timestamp: new Date().toISOString(),
      sessionId,
      error: 'rate_limit',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(resetsAt / 1000) },
      message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: `You've hit your limit · resets ${reset}` }] },
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch {
    // 写不了会话记录：AgentDeck 读不到恢复时间（reset-unknown）
  }
  if (limited?.timer) clearTimeout(limited.timer);
  limited = { self, resetsAt, pending: null, timer: null };
  state = 'idle';
  log({ kind: 'limit', resetsAt: new Date(resetsAt).toISOString(), self });
  await emitHook('StopFailure', { error: 'rate_limit', error_details: '429', transcript_path: file });
  write(`  ⎿ Usage limit reached · limit resets ${reset}\n`);
  if (self) {
    write(`    Continuing automatically at ${reset} · esc to cancel\n`);
    limited.timer = setTimeout(() => void selfResume(), resetsAt - Date.now());
  } else {
    await emitHook('Notification', { notification_type: 'quota_auto_resume_disabled', message: 'Auto-continue is off' });
  }
  prompt();
}

/** 到了恢复时间，claude 自己续：先 fired，再发等的时候收到的那一行（没有就发自己的 continue）。 */
async function selfResume() {
  if (!limited?.self) return;
  const sent = limited.pending;
  limited = null;
  state = 'working';
  await emitHook('Notification', { notification_type: 'quota_auto_resume_fired', message: 'Continuing after the usage limit reset' });
  log({ kind: 'self-resume', sent });
  await emitHook('UserPromptSubmit', { prompt: sent ?? 'Continue from where you left off.' });
  write(sent ? `\n> ${sent}\n  Working… (type done to finish)\n` : '\n  Continuing from where you left off… (type done to finish)\n');
}

/** @param {string} input */
async function runLine(input) {
  if (limited && input.trim() !== '' && !/^(quit|exit|crash)$/.test(input.trim())) {
    if (limited.self) {
      // 等着自己续的时候收到消息：到点改发它
      limited.pending = input;
      log({ kind: 'queued-while-limited', line: input });
      write('  Will send this when the limit resets.\n');
      prompt();
      return;
    }
    // 关了自己续：当成普通的提示词
    limited = null;
    state = 'working';
    log({ kind: 'prompt', line: input });
    await emitHook('UserPromptSubmit', { prompt: input });
    write('  Working… (type done to finish)\n');
    return;
  }
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
    case 'limit':
      await hitLimit(rest);
      return;
    case 'done':
      state = 'idle';
      await emitHook('Stop', { stop_hook_active: false });
      write(rest.length > 0 ? `\n● ${rest.join(' ')}\n\n` : '  Done.\n');
      prompt();
      return;
    case 'clear':
      sessionId = randomUUID();
      await emitHook('SessionStart', { source: 'clear' });
      write(`  Cleared. session: ${sessionId}\n`);
      prompt();
      return;
    case 'compact':
      await emitHook('SessionStart', { source: 'compact' });
      write('  Compacted.\n');
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

/** 在 bracketed paste（ESC[200~ … ESC[201~）里面：换行当空格，不提交。 */
let pasting = false;

/** @param {string} chunk */
function onInput(chunk) {
  // AgentDeck 的续跑（LimitService）用 bracketed paste 送一整段，回车另外发
  for (const part of chunk.split(/(\x1b\[20[01]~)/)) {
    if (part === '\x1b[200~') pasting = true;
    else if (part === '\x1b[201~') pasting = false;
    else onChars(part);
  }
}

/** @param {string} chunk */
function onChars(chunk) {
  for (const ch of chunk) {
    if (pasting && (ch === '\r' || ch === '\n')) {
      line += ' ';
      write(' ');
      continue;
    }
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
