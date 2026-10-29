#!/usr/bin/env node
// 端到端测试用的假 codex（g3：TC-40、TC-41、TC-80、TC-81、TC-109）。在沙盒里以 `codex` 的名字放进 PATH，AgentDeck 的 codex 适配器把它当真的：
//   codex --version              → codex-cli 0.165.0（compat/codex.json 核对到的版本）
//   codex app-server -c hooks.…  → JSON-RPC（一行一个）：initialize、hooks/list 报出这几条钩子的 key 和哈希（source: sessionFlags），
//                                  和真 codex 一样，AgentDeck 再用 -c hooks.state={…} 把它们标成信任
//   codex [resume <id>] -c hooks.<事件>=[{hooks=[{type="command",command="…",timeout=N}]}] -c hooks.state={…} [-- 第一条消息]
// 钩子只在 hooks.state 里信任了（key 和哈希都对上）才运行，负载照 codex 0.159.2 实测的字段（session_id、tool_name、tool_input……）。
// 会话记录照真 codex 写在 $CODEX_HOME（没设是 ~/.codex）/sessions/YYYY/MM/DD/rollout-<时间>-<id>.jsonl：session_meta、turn_context、
// event_msg token_count（info 的 total / last、model_context_window，rate_limits 的 5 小时和每周两个窗口）、task_complete。
//
// 在终端里打字控制它（像对 codex 说话；回车提交）：
//   work                 → UserPromptSubmit，running
//   ask [命令]            → UserPromptSubmit + PermissionRequest（Bash，默认 ls -la），画确认框；y 允许一次 → PostToolUse，Esc / n → Interrupt
//                          钩子回 allow（Auto-approve）时直接批准
//   done [回复]           → 记一次请求的用量（token_count，每轮 input +1000、cached +200、output +50），task_complete，Stop；带回复时画 “• 回复”
//   limit <秒|@epoch秒>   → 像真 codex 撞上 5 小时额度：token_count 的 rate_limits.primary 用到 100%（resets_at），
//                          task_complete 带 error usage_limit_exceeded，Stop；之后收到的一行（AgentDeck 续跑时 bracketed paste + 回车）当提示词
//   sql                  → 画一段多行 SQL（带 -- 注释），像 codex 的回答（TC-109）
//   其他任何一行          → 当提示词：UserPromptSubmit，running（日志 kind: prompt）
//   quit / exit          → SessionEnd，退出码 0
// 第一次输入时才发 SessionStart（codex 0.159 实测如此），会话记录也是那时建。
// 日志：$AGENTDECK_E2E_LOG_DIR/codex-<启动时间>.jsonl（deck.agentLog(terminalId) 按 terminal 认）。

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger, readLines, runHookCommand, uuid7, write } from './fake-common.mjs';

const VERSION = '0.165.0';
const MODEL = 'gpt-test-codex';
const WINDOW = 258_400;
const argv = process.argv.slice(2);

if (argv[0] === '--version' || argv[0] === '-V') {
  process.stdout.write(`codex-cli ${VERSION}\n`);
  process.exit(0);
}

/** 每对 -c 的值。 */
/** @type {string[]} */
const overrides = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '-c' && argv[i + 1] !== undefined) overrides.push(argv[++i] ?? '');

/** -c hooks.<事件>=[{hooks=[{…command="…"…}]}] → 事件 → 命令。 */
/** @type {Map<string, string>} */
const hookCommands = new Map();
for (const o of overrides) {
  const m = /^hooks\.([A-Za-z]+)=.*command=("(?:[^"\\]|\\.)*")/.exec(o);
  if (m?.[1] && m[1] !== 'state') hookCommands.set(m[1], /** @type {string} */ (JSON.parse(m[2] ?? '""')));
}
const keyOf = (/** @type {string} */ event) => `/<session-flags>/config.toml:${event.toLowerCase()}:0:0`;
const hashOf = (/** @type {string} */ command) => `sha256:${createHash('sha256').update(command).digest('hex')}`;

if (argv[0] === 'app-server') {
  // AgentDeck 启动前问钩子的信任哈希（adapters/codex.ts queryTrustViaAppServer）
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === 1) process.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: `codex/${VERSION}` } })}\n`);
      if (msg.id === 2) {
        const hooks = [...hookCommands].map(([event, command]) => ({
          key: keyOf(event),
          eventName: event,
          command,
          currentHash: hashOf(command),
          source: 'sessionFlags',
          trustStatus: 'untrusted',
        }));
        const cwd = msg.params?.cwds?.[0] ?? process.cwd();
        process.stdout.write(`${JSON.stringify({ id: 2, result: { data: [{ cwd, hooks }] } })}\n`);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  runTui();
}

function runTui() {
  // hooks.state={"<key>"={trusted_hash="sha256:…"},…}：只运行信任了的钩子
  /** @type {Map<string, string>} */
  const trusted = new Map();
  for (const o of overrides) {
    if (!o.startsWith('hooks.state=')) continue;
    for (const m of o.matchAll(/("(?:[^"\\]|\\.)*")=\{trusted_hash=("(?:[^"\\]|\\.)*")\}/g)) trusted.set(JSON.parse(m[1] ?? '""'), JSON.parse(m[2] ?? '""'));
  }
  /** @param {string} event */
  const commandFor = (event) => {
    const command = hookCommands.get(event) ?? null;
    return command && trusted.get(keyOf(event)) === hashOf(command) ? command : null;
  };

  const resumeAt = argv[0] === 'resume' ? 1 : -1;
  let sessionId = resumeAt >= 0 ? (argv[resumeAt] ?? uuid7()) : uuid7();
  const dashes = argv.indexOf('--');
  const firstPrompt = dashes >= 0 ? argv.slice(dashes + 1).join(' ') || null : null;
  const log = logger(`codex-${Date.now()}-${process.pid}`);
  log({ kind: 'start', argv: argv.filter((a) => !a.startsWith('hooks.')), hooks: [...hookCommands.keys()], trusted: trusted.size });

  let started = false;
  /** @type {'idle' | 'working' | 'approval'} */
  let state = 'idle';
  /** @type {{ tool_name: string, tool_input: { command: string, description: string } } | null} */
  let pending = null;
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  /** 撞上额度以后（limit）：rate_limits 报 100%，直到下一次成功的请求。 */
  let limitedUntil = 0;

  const home = process.env['CODEX_HOME'] || join(homedir(), '.codex');
  const now = new Date();
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const day = join(home, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const rolloutFile = () => join(day, `rollout-${stamp}-${sessionId}.jsonl`);
  /** @param {string} type @param {Record<string, unknown>} payload */
  const record = (type, payload) => {
    try {
      mkdirSync(day, { recursive: true });
      appendFileSync(rolloutFile(), `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`);
    } catch {
      // 写不了：AgentDeck 读不到用量
    }
  };
  const rateLimits = () => {
    const reset5h = limitedUntil > Date.now() ? Math.floor(limitedUntil / 1000) : Math.floor(Date.now() / 1000) + 4 * 3600;
    return {
      primary: { used_percent: limitedUntil > Date.now() ? 100.0 : 12.0, window_minutes: 300, resets_at: reset5h },
      secondary: { used_percent: 31.0, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 5 * 86400 },
    };
  };
  const tokenCount = (/** @type {boolean} */ withInfo) => {
    const last = { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 };
    if (withInfo) {
      total.input_tokens += last.input_tokens;
      total.cached_input_tokens += last.cached_input_tokens;
      total.output_tokens += last.output_tokens;
      total.reasoning_output_tokens += last.reasoning_output_tokens;
      total.total_tokens += last.total_tokens;
    }
    record('event_msg', {
      type: 'token_count',
      info: withInfo ? { total_token_usage: { ...total }, last_token_usage: { ...last, total_tokens: total.total_tokens }, model_context_window: WINDOW } : null,
      rate_limits: rateLimits(),
    });
  };

  /** 跑钩子（按顺序）。 */
  let chain = Promise.resolve('');
  /** @param {string} event @param {Record<string, unknown>} extra */
  const hook = (event, extra = {}) => {
    const payload = { session_id: sessionId, hook_event_name: event, model: MODEL, permission_mode: 'default', cwd: process.cwd(), ...extra };
    const run = () => {
      const command = commandFor(event);
      log({ kind: 'hook', event, payload, wired: command !== null });
      return runHookCommand(command, payload);
    };
    chain = chain.then(run, run);
    return chain;
  };

  const prompt = () => write('› ');
  const ensureStarted = async () => {
    if (started) return;
    started = true;
    record('session_meta', { id: sessionId, session_id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd(), originator: 'codex-tui', cli_version: VERSION });
    record('turn_context', { turn_id: 't1', cwd: process.cwd(), model: MODEL, effort: 'medium' });
    tokenCount(false);
    await hook('SessionStart', { source: resumeAt >= 0 ? 'resume' : 'startup' });
  };

  const approve = (/** @type {string} */ how) => {
    if (state !== 'approval' || !pending) return;
    const tool = pending;
    pending = null;
    state = 'working';
    log({ kind: 'approved', how, command: tool.tool_input.command });
    write(`  ✓ Approved (${how})\n  Ran ${tool.tool_input.command}\n  Working…\n`);
    void hook('PostToolUse', { ...tool, tool_response: { output: '', exit_code: 0 } });
  };
  const deny = () => {
    if (state !== 'approval') return;
    pending = null;
    state = 'idle';
    log({ kind: 'denied' });
    write('  ✗ Denied\n');
    void hook('Interrupt', {});
    prompt();
  };

  /** @param {string} input */
  const runLine = async (input) => {
    const [cmd = '', ...rest] = input.trim().split(/\s+/);
    if (cmd === '') {
      prompt();
      return;
    }
    await ensureStarted();
    switch (cmd) {
      case 'quit':
      case 'exit':
        await hook('SessionEnd', { reason: 'exit' });
        log({ kind: 'exit' });
        process.exit(0);
        return;
      case 'ask': {
        const command = rest.join(' ') || 'ls -la';
        state = 'approval';
        pending = { tool_name: 'Bash', tool_input: { command, description: `Allow running ${command}?` } };
        await hook('UserPromptSubmit', { prompt: input });
        write(`\n  Would you like to run the following command?\n\n  $ ${command}\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for this command (p)\n  3. No, and tell Codex what to do differently (esc)\n`);
        const out = await hook('PermissionRequest', pending);
        if (/"behavior"\s*:\s*"allow"/.test(out)) {
          log({ kind: 'auto-approved', command });
          approve('hook');
        }
        return;
      }
      case 'done': {
        state = 'idle';
        limitedUntil = 0;
        tokenCount(true);
        const reply = rest.join(' ');
        record('event_msg', { type: 'task_complete', last_agent_message: reply || 'Done.' });
        await hook('Stop', { stop_hook_active: false, last_assistant_message: reply || 'Done.' });
        write(reply ? `\n• ${reply}\n\n` : '  Done.\n');
        prompt();
        return;
      }
      case 'limit': {
        const arg = rest[0] ?? '60';
        const resetsAt = arg.startsWith('@') ? Number(arg.slice(1)) * 1000 : Date.now() + Math.max(1, Number(arg) || 60) * 1000;
        limitedUntil = resetsAt;
        state = 'idle';
        const when = new Date(resetsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        tokenCount(false);
        record('event_msg', {
          type: 'task_complete',
          last_agent_message: null,
          error: { message: `You've hit your usage limit. Upgrade to Pro or try again at ${when}.`, codex_error_info: 'usage_limit_exceeded' },
        });
        log({ kind: 'limit', resetsAt: new Date(resetsAt).toISOString() });
        await hook('Stop', { stop_hook_active: false, last_assistant_message: null });
        write(`\n■ You've hit your usage limit. Try again at ${when}.\n`);
        prompt();
        return;
      }
      case 'sql':
        write(
          '\n• Here is the query:\n\n' +
            'SELECT o.id, o.total, c.email\n' +
            'FROM orders o\n' +
            'JOIN customers c ON c.id = o.customer_id\n' +
            '-- only last week\n' +
            "WHERE o.created_at > now() - interval '7 days';\n\n",
        );
        prompt();
        return;
      case 'work':
      default:
        // 普通的一句话：当提示词（AgentDeck 续跑时送进来的话也走这里）
        state = 'working';
        log({ kind: 'prompt', line: input });
        await hook('UserPromptSubmit', { prompt: input });
        write('  Working… (type done to finish)\n');
    }
  };

  // 一行一行按顺序处理（前一行的钩子跑完再处理下一行），快速连着打的几行不会乱序
  let lines = Promise.resolve();
  const queueLine = (/** @type {string} */ line) => {
    lines = lines.then(() => runLine(line)).catch(() => undefined);
  };

  write(`\x1b[1m>_ Fake Codex (AgentDeck e2e)\x1b[0m  v${VERSION}\n  model: ${MODEL}   directory: ${process.cwd()}\n\n`);
  readLines({
    onKey: (ch) => {
      if (state !== 'approval') return false;
      if (ch === 'y' || ch === '1' || ch === '\r') approve('key');
      else if (ch === '\x1b' || ch === 'n') deny();
      else log({ kind: 'key-ignored', key: ch });
      return true;
    },
    onLine: (line) => {
      log({ kind: 'input', line });
      queueLine(line);
    },
  });
  if (firstPrompt) queueLine(firstPrompt);
  else prompt();
}
