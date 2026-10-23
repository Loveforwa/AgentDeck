// 真实 agent 对比：同一组按键，直接在 xterm 里跑一遍，经过 tmux 再跑一遍，逐步对比结果。
//
//   node agent.mjs claude|codex [--only direct|tmux] [--verbose]
//
// 安全：只发“只问问题”的提示词（Reply with OK、数数），claude 用 plan 模式，
// codex 用只读沙箱，并且用临时 CODEX_HOME（复制 auth.json 和 config.toml，加上对仓库的信任），
// 不改用户自己的 ~/.codex。
// 发出的字节和 xterm.js 的编码一致；Shift+Enter 用 CSI u（ESC [ 13 ; 2 u），
// 这是 T3 需要自己映射的（xterm.js 默认把 Shift+Enter 当成回车，见 AGENTS.md）。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { View, attachView, cleanEnv, fmt, newSession, sleep, tmuxOk, waitUntil, PKG_DIR } from './lib.mjs';

const args = process.argv.slice(2);
const which = args[0];
if (which !== 'claude' && which !== 'codex') throw new Error('usage: agent.mjs claude|codex');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const verbose = args.includes('--verbose');
const REPO = path.resolve(PKG_DIR, '../..');
const ESC = '\x1b';
const KEY = {
  enter: '\r',
  shiftEnter: '\x1b[13;2u',
  altEnter: '\x1b\r',
  esc: ESC,
  ctrlC: '\x03',
  tab: '\t',
  shiftTab: '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
};
const sgr = (b, x, y) => `\x1b[<${b};${x};${y}M`;

// ---------------------------------------------------------------- 每个 agent 的启动方式和输入框解析

function setupCodexHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-codex-home-'));
  const src = path.join(os.homedir(), '.codex');
  fs.copyFileSync(path.join(src, 'auth.json'), path.join(home, 'auth.json'));
  const userConf = fs.existsSync(path.join(src, 'config.toml')) ? fs.readFileSync(path.join(src, 'config.toml'), 'utf8') : '';
  const root = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim().replace(/\/\.git$/, '');
  // 用户自己的配置里已经有的键不能再写一遍（TOML 不许重复）。顶层键必须写在第一个 [table] 之前。
  const top = /^check_for_update_on_startup\s*=/m.test(userConf) ? '' : 'check_for_update_on_startup = false\n';
  const trust = [...new Set([root, REPO])]
    .filter((dir) => !userConf.includes(`[projects.${JSON.stringify(dir)}]`))
    .map((dir) => `\n[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`)
    .join('');
  fs.writeFileSync(path.join(home, 'config.toml'), `${top}${userConf}\n${trust}`);
  return home;
}

const AGENTS = {
  claude: {
    argv: ['claude', '--permission-mode', 'plan'],
    env: () => ({}),
    ready: (t) => t.includes('❯') && /plan mode on/.test(t),
    // 输入框：最后一个以“❯ ”开头的行，到下一条横线为止。
    input(lines) {
      let i = lines.findLastIndex((l) => l.startsWith('❯ ') || l === '❯');
      if (i < 0) return null;
      const out = [];
      for (; i < lines.length && !lines[i].startsWith('─'); i++) out.push(lines[i].replace(/^(❯ ?| {2})/, '').trimEnd());
      return out;
    },
    empty: (inp) => inp && inp.length === 1 && (inp[0] === '' || inp[0].startsWith('Try "')),
    menuPrefix: '/hel',
    menuMarker: /^ {2}❯ \//,
    answered: (t) => /⏺\s*OK\b/.test(t),
    // 本机 claude CLI 没登录时（从 Claude 桌面版里跑，认证不会带进干净环境）会回 API Error。
    notLoggedIn: (t) => /Please run \/login|API Error: 40[13]/.test(t),
    // 长输出和“忙”不依赖模型：用 claude 的 ! 命令模式跑 seq 和 sleep（用户自己执行的命令，没有副作用）。
    long: ['!', 'seq 1 80', '\r'],
    longDone: (t) => /^\s*80\s*$/m.test(t) && !/esc to interrupt/i.test(t),
    busy: ['!', 'sleep 30', '\r'],
    working: (t) => /esc to interrupt/i.test(t),
    interrupted: (t) => !/esc to interrupt/i.test(t) && !/Running…/.test(t),
    statusLine: (lines) => lines.find((l) => /mode on|shortcuts/.test(l)) ?? '',
    banner: 'Claude Code v',
    slash: ['/hel', '/help'],
    // 输入框上下的横线；“❯”在 ! 命令模式下会变成“!”。
    timingMarker: '────',
  },
  codex: {
    argv: ['codex', '-s', 'read-only', '-a', 'on-request'],
    env: () => ({ CODEX_HOME: setupCodexHome() }),
    ready: (t) => t.includes('OpenAI Codex') && /^› /m.test(t),
    // 输入框：最后一个以“› ”开头的行，到空行为止。
    input(lines) {
      let i = lines.findLastIndex((l) => l.startsWith('› '));
      if (i < 0) return null;
      const out = [];
      for (; i < lines.length && lines[i].trim() !== ''; i++) out.push(lines[i].replace(/^(› | {2})/, '').trimEnd());
      return out;
    },
    empty: (inp) => inp && inp.length === 1 && (inp[0] === '' || /^(Ask Codex|Find and fix|Explain|Summarize|Write tests|Improve|Implement|Use \/|Run )/.test(inp[0])),
    menuPrefix: '/',
    menuMarker: /^› \/\w+\s{2,}\S/,
    answered: (t) => /^\s*• OK\b/m.test(t),
    notLoggedIn: (t) => /Sign in with ChatGPT|Not logged in|401 Unauthorized/.test(t),
    long: ['Print the numbers 1 to 60, one per line, with no other text. Do not use any tools.', '\r'],
    longDone: (t) => /^\s*60\s*$/m.test(t) && /Worked for/.test(t),
    busy: ['Count from 1 to 400, one number per line, with no other text. Do not use any tools.', '\r'],
    working: (t) => /esc to interrupt/i.test(t),
    interrupted: (t) => /Conversation interrupted/.test(t),
    statusLine: (lines) => lines.find((l) => /for shortcuts|to queue/.test(l)) ?? '',
    banner: 'OpenAI Codex',
    slash: ['/mod', '/model'],
    timingMarker: '›',
  },
};
const A = AGENTS[which];

// ---------------------------------------------------------------- 场景

/** 每一步：发字节，等，检查。返回 [名字, 结果字符串或 true/false]。 */
async function scenario(ctx) {
  const r = [];
  // ok：true / false / 'skip'（前提不满足，没法测）
  const add = (name, ok, detail = '') => r.push({ name, ok: ok === 'skip' ? 'skip' : !!ok, detail });
  // claude 在“❯”后面用的是不换行空格（U+00A0）。
  const lines = () => ctx.v.lines().map((l) => l.replace(/\u00a0/g, ' '));
  const inp = () => A.input(lines());
  const type = async (s, ms = 400) => {
    ctx.v.write(s);
    await sleep(ms);
  };
  const shot = (label) => {
    if (verbose) console.log(`--- ${ctx.mode} · ${label}\n${ctx.v.lines().filter((l) => l.trim()).join('\n')}`);
  };

  const readyAt = await ctx.v.waitScreen(A.ready, 30000);
  add('starts and shows its input box', readyAt !== null);
  if (readyAt === null) {
    console.log(`--- ${ctx.mode} · not ready after 30 s\n${ctx.v.lines().filter((l) => l.trim()).join('\n')}`);
    return r;
  }
  await sleep(1500);
  ctx.colors = ctx.v.colors();
  ctx.firstScreen = ctx.v.lines();
  shot('ready');

  await type('hello world');
  add('typing', inp()?.[0] === 'hello world', JSON.stringify(inp()));
  await type(KEY.shiftEnter);
  await type('line2');
  add('Shift+Enter (CSI u) inserts a newline', inp()?.length === 2 && inp()[1] === 'line2', JSON.stringify(inp()));
  await type(KEY.home);
  await type('X');
  add('Home (tmux sends ESC[1~)', inp()?.[1] === 'Xline2', JSON.stringify(inp()));
  await type(KEY.end);
  await type('Z');
  add('End (tmux sends ESC[4~)', inp()?.[1] === 'Xline2Z', JSON.stringify(inp()));
  await type(KEY.altEnter);
  await type('alt');
  add('Option+Enter (ESC CR) inserts a newline', inp()?.length === 3 && inp()[2] === 'alt', JSON.stringify(inp()));
  await type(KEY.left + KEY.left);
  await type('Y');
  add('Left arrow', inp()?.[2] === 'aYlt', JSON.stringify(inp()));
  shot('after editing');
  await type(KEY.ctrlC, 600);
  add('Ctrl+C clears the input', A.empty(inp()), JSON.stringify(inp()));
  shot('after ctrl-c');

  ctx.v.paste('alpha\nbeta\ngamma');
  await sleep(800);
  const pasted = inp();
  add('multi-line paste stays in the input (not submitted)', pasted && (pasted.join('\n').includes('alpha\nbeta\ngamma') || /Pasted/.test(pasted.join(' '))) && !A.answered(ctx.v.text()), JSON.stringify(pasted));
  shot('after paste');
  await type(KEY.ctrlC, 600);

  await type(A.menuPrefix, 300);
  await waitUntil(() => lines().some((l) => A.menuMarker.test(l)), 5000, 100);
  await sleep(300);
  const menuBefore = lines().find((l) => A.menuMarker.test(l)) ?? '';
  await type(KEY.down, 500);
  const menuAfter = lines().find((l) => A.menuMarker.test(l)) ?? '';
  add('Down arrow moves the selection in the slash menu', menuBefore && menuAfter && menuBefore !== menuAfter, `${menuBefore.trim().split(/\s{2,}/)[0]} -> ${menuAfter.trim().split(/\s{2,}/)[0]}`);
  await type(KEY.esc, 500);
  await type(KEY.ctrlC, 600);
  if (!A.empty(inp())) await type(KEY.ctrlC, 600);
  await waitUntil(() => A.empty(inp()), 3000, 100);
  await type(A.slash[0], 800);
  await type(KEY.tab, 800);
  add('Tab completes the slash command', inp()?.[0]?.startsWith(A.slash[1]), JSON.stringify(inp()));
  shot('after tab');
  await type(KEY.esc, 600);
  await type(KEY.ctrlC, 600);
  if (!A.empty(inp())) await type(KEY.ctrlC, 600);

  if (which === 'claude') {
    // 按过 Ctrl+C 后状态栏会显示几秒“Press Ctrl-C again to exit”。
    await waitUntil(() => /mode on/.test(A.statusLine(lines())), 8000, 100);
    const before = A.statusLine(lines());
    await type(KEY.shiftTab, 700);
    const after = A.statusLine(lines());
    add('Shift+Tab cycles the permission mode', before !== after, `${before.trim().slice(0, 30)} -> ${after.trim().slice(0, 30)}`);
    // 转回 plan 模式再提交提示词。
    for (let i = 0; i < 6 && !/plan mode on/.test(A.statusLine(lines())); i++) await type(KEY.shiftTab, 700);
    if (!/plan mode on/.test(A.statusLine(lines()))) {
      add('back in plan mode before submitting', false, A.statusLine(lines()));
      return r;
    }
  }

  await type('Reply with just the word OK and nothing else.', 500);
  await type(KEY.enter, 200);
  // codex 的后端有时要重连，一次回答可能要一两分钟。
  const answered = await ctx.v.waitScreen((t) => A.answered(t) || A.notLoggedIn(t), 240000);
  const loggedOut = A.notLoggedIn(ctx.v.text());
  add('Enter submits; agent answers', loggedOut ? 'skip' : answered !== null, loggedOut ? 'agent CLI is not logged in here (API error); only the submit was checked' : '');
  shot('after answer');
  await sleep(1500);

  await type(KEY.up, 700);
  add('Up recalls the previous prompt', inp()?.join(' ').includes('Reply with just the word OK'), JSON.stringify(inp()));
  await type(KEY.ctrlC, 600);
  if (!A.empty(inp())) await type(KEY.ctrlC, 600);
  await waitUntil(() => A.empty(inp()), 3000, 100);

  // 先打出一段比屏幕长的输出，后面测滚动用。
  for (const k of A.long) await type(k, 500);
  const printed = await ctx.v.waitScreen((t) => A.longDone(t.replace(/\u00a0/g, ' ')), 180000);
  add('long output finishes', printed !== null);
  await sleep(2000);
  shot('after long output');
  // 滚动：claude 在主屏、不要鼠标 → tmux copy-mode；codex 在备用屏、要鼠标 → 滚轮交给 codex。
  const beforeScroll = ctx.v.text();
  if (ctx.mode === 'direct' && !ctx.v.term.modes.mouseTrackingMode.match(/any|drag|vt200|x10/)) {
    ctx.v.term.scrollLines(-30); // xterm.js 自己的回滚（没有鼠标上报时，滚轮由 xterm.js 处理）
  } else {
    for (let i = 0; i < 10; i++) await type(sgr(64, 20, 10), 60);
  }
  await sleep(600);
  const scrolled = ctx.v.text();
  const inMode = ctx.mode === 'tmux' ? fmt(ctx.target, '#{pane_in_mode}') : '-';
  add('mouse wheel up scrolls back', scrolled !== beforeScroll, `pane_in_mode=${inMode}`);
  shot('scrolled');
  if (ctx.mode === 'direct' && !ctx.v.term.modes.mouseTrackingMode.match(/any|drag|vt200|x10/)) ctx.v.term.scrollToBottom();
  else for (let i = 0; i < 15; i++) await type(sgr(65, 20, 10), 60);
  await sleep(600);
  add('wheel down returns to the live screen', ctx.mode === 'tmux' ? fmt(ctx.target, '#{pane_in_mode}') === '0' : true, ctx.mode === 'tmux' ? `pane_in_mode=${fmt(ctx.target, '#{pane_in_mode}')}` : '');

  for (const k of A.busy) await type(k, 500);
  const working = await ctx.v.waitScreen(A.working, 60000);
  add('agent starts working', working !== null);
  if (ctx.reattach) {
    // 生成中途断开再接上：输出应该继续，接上后看到的是最新的屏幕。
    await sleep(1000);
    await ctx.reattach(2000);
    shot('re-attached');
    // codex 在输出数字时不显示“esc to interrupt”，所以也接受“接上后屏幕还在更新”。
    const snap = ctx.v.text();
    const live = A.working(snap) || (await ctx.v.waitScreen((t) => t !== snap, 3000)) !== null;
    add('detach mid-turn, re-attach 2 s later: still running, screen is current', live, '');
  } else {
    await sleep(3000);
  }
  shot('working');
  await type(KEY.esc, 200);
  const stopped = await ctx.v.waitScreen(A.interrupted, 10000);
  add('Esc interrupts the turn', stopped !== null);
  shot('after esc');
  return r;
}

// ---------------------------------------------------------------- 运行

async function run(mode) {
  const env = A.env();
  const ctx = { mode };
  if (mode === 'direct') {
    // 和 tmux.conf 里的 set-environment 一致：界面里的终端也会给 agent COLORTERM=truecolor。
    ctx.v = new View(A.argv[0], A.argv.slice(1), { cwd: REPO, env: cleanEnv({ COLORTERM: 'truecolor', ...env }) });
  } else {
    const id = `agent-${which}`;
    tmuxOk(['kill-session', '-t', `=${id}`]);
    newSession(id, A.argv, { cwd: REPO, env });
    ctx.id = id;
    ctx.target = `=${id}:`;
    ctx.v = attachView(id);
    ctx.reattach = async (gapMs) => {
      ctx.v.kill('SIGHUP');
      await ctx.v.exited;
      await sleep(gapMs);
      ctx.v = attachView(id);
      await ctx.v.waitScreen(() => ctx.v.firstDataAt !== null, 3000);
      await sleep(300);
    };
  }
  const steps = await scenario(ctx);
  if (mode === 'tmux') {
    ctx.info = fmt(ctx.target, 'pane_current_command=#{pane_current_command} key_mode=#{pane_key_mode} alternate_on=#{alternate_on} mouse_any_flag=#{mouse_any_flag} pane_title=#{pane_title}');
  }
  return { ctx, steps, env };
}

const runs = {};
for (const mode of ['direct', 'tmux']) {
  if (only && only !== mode) continue;
  runs[mode] = await run(mode);
  if (mode === 'direct') {
    runs[mode].ctx.v.kill();
    await runs[mode].ctx.v.exited;
  }
}

// 同一个会话上量 attach/detach（真实 agent 的首屏）
let timing = null;
if (runs.tmux) {
  runs.tmux.ctx.v.kill('SIGHUP');
  await runs.tmux.ctx.v.exited;
  const out = execFileSync('node', [path.join(PKG_DIR, 'scripts', 'timing.mjs'), '--session', runs.tmux.ctx.id, '--marker', A.timingMarker, '--n', '20'], { encoding: 'utf8', env: process.env });
  timing = JSON.parse(out);
  tmuxOk(['kill-session', '-t', `=${runs.tmux.ctx.id}`]);
}

// ---------------------------------------------------------------- 输出
const names = [...new Set(Object.values(runs).flatMap((x) => x.steps.map((s) => s.name)))];
const w = Math.max(...names.map((n) => n.length));
console.log(`\n${which}  (direct = node-pty + xterm without tmux; tmux = through tmux -L agentdeck)`);
for (const n of names) {
  const cell = (mode) => {
    const s = runs[mode]?.steps.find((x) => x.name === n);
    if (!s) return '-'.padEnd(6);
    return (s.ok === 'skip' ? 'skip' : s.ok ? 'ok' : 'FAIL').padEnd(6);
  };
  const detail = runs.tmux?.steps.find((x) => x.name === n)?.detail ?? runs.direct?.steps.find((x) => x.name === n)?.detail ?? '';
  const ddetail = runs.direct?.steps.find((x) => x.name === n)?.detail ?? '';
  console.log(`${n.padEnd(w)}  direct ${cell('direct')} tmux ${cell('tmux')} ${detail}${ddetail && ddetail !== detail ? `  (direct: ${ddetail})` : ''}`);
}
if (runs.direct?.ctx.colors && runs.tmux?.ctx.colors) {
  const keys = (m) => [...m.keys()].sort();
  const a = runs.direct.ctx.colors;
  const b = runs.tmux.ctx.colors;
  console.log(`colors on the first screen: fg same=${JSON.stringify(keys(a.fg)) === JSON.stringify(keys(b.fg))} bg same=${JSON.stringify(keys(a.bg)) === JSON.stringify(keys(b.bg))} attrs same=${JSON.stringify(keys(a.attrs)) === JSON.stringify(keys(b.attrs))}`);
  console.log(`  direct fg ${JSON.stringify(keys(a.fg))}\n  tmux   fg ${JSON.stringify(keys(b.fg))}`);
  console.log(`  direct bg ${JSON.stringify(keys(a.bg))}\n  tmux   bg ${JSON.stringify(keys(b.bg))}`);
  console.log(`  direct attrs ${JSON.stringify(keys(a.attrs))}\n  tmux   attrs ${JSON.stringify(keys(b.attrs))}`);
}
if (runs.tmux) console.log(`tmux pane: ${runs.tmux.ctx.info}`);
if (timing) console.log(`timing on the ${which} session: ${JSON.stringify(timing)}`);
// codex 会在 CODEX_HOME 下起一个常驻的 app-server 守护进程（还会自己下载更新），TUI 退出后它还在。
// 按路径结束这些进程再删目录；用户自己 ~/.codex 下的守护进程不动。
for (const r of Object.values(runs)) {
  if (!r.env.CODEX_HOME) continue;
  try {
    execFileSync('pkill', ['-f', r.env.CODEX_HOME]);
  } catch {
    // 没有这样的进程
  }
  fs.rmSync(r.env.CODEX_HOME, { recursive: true, force: true });
}
process.exit(0);
