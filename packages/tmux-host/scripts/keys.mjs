// 透传测试：经过 tmux 一层后，agent 收到的字节、外层 xterm 收到的模式和颜色，是否和直接运行一样。
//
// 链路和 T2 一致：xterm（headless）→ node-pty → tmux attach → tmux 服务 → 窗格里的 keyprobe.py。
// 发送的字节就是 xterm.js 对这些按键的编码；“直接运行”时探针收到的就是这些字节，
// 所以“经过 tmux 收到的 == 发出的”即为一致。

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { View, attachView, cleanEnv, fmt, hex, newSession, show, sleep, stats, tmuxOk, waitUntil, PKG_DIR } from './lib.mjs';

const PROBE = path.join(PKG_DIR, 'scripts', 'keyprobe.py');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-keys-'));
const results = [];
// ok：true / false / 'note'（和直接运行不同，但已经确认无害或是预期的，原因见 AGENTS.md）
const record = (group, name, ok, detail) => {
  results.push({ group, name, ok, detail });
};
// 已知、已解释的差异：tmux 按 tmux-256color 的 terminfo 重新编码 Home/End（claude、codex 都认，
// agent.mjs 里实测）；程序没申请扩展按键时（extended-keys on），Shift+Enter 按普通回车交给它。
const KNOWN = new Set(['Home', 'End', 'S-Enter as CSI u', 'S-Enter as xterm modifyOtherKeys']);

let seq = 0;
/** 起一个跑探针的会话并 attach；返回发送和读取日志的工具。 */
async function probe(modes, { direct = false, answerQueries = true } = {}) {
  const id = `keys${seq++}`;
  const log = path.join(tmpDir, `${id}.log`);
  fs.writeFileSync(log, '');
  let v;
  if (direct) {
    v = new View('python3', ['-I', PROBE, log, ...modes], { cwd: PKG_DIR, env: cleanEnv(), answerQueries });
  } else {
    newSession(id, ['python3', '-I', PROBE, log, ...modes], { cwd: PKG_DIR });
    v = attachView(id, { answerQueries });
  }
  await v.waitScreen((t) => t.includes('PROBE READY'), 5000);
  await waitUntil(() => fs.readFileSync(log, 'utf8').includes('ready'), 3000);
  await sleep(100);
  let consumed = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  const entries = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(1).map((l) => {
    const [ts, h] = l.split(' ');
    return { ts: Number(ts), hex: h };
  });
  return {
    id,
    v,
    target: `=${id}:`,
    /** 发送并收集探针在 quietMs 内收到的全部字节（十六进制）。 */
    async send(data, quietMs = 150) {
      v.write(data);
      await sleep(quietMs);
      const all = entries();
      const fresh = all.slice(consumed - 1);
      consumed = all.length + 1;
      return fresh.map((e) => e.hex).join('');
    },
    entries,
    async close() {
      v.kill('SIGHUP');
      await v.exited;
      if (!direct) tmuxOk(['kill-session', '-t', `=${id}`]);
    },
  };
}

const keys = [
  ['a', 'a'],
  ['Esc', '\x1b'],
  ['C-c', '\x03'],
  ['Tab', '\t'],
  ['S-Tab', '\x1b[Z'],
  ['Enter', '\r'],
  ['Backspace', '\x7f'],
  ['C-a', '\x01'],
  ['C-b (tmux default prefix)', '\x02'],
  ['C-z', '\x1a'],
  ['C-r', '\x12'],
  ['Up', '\x1b[A'],
  ['Down', '\x1b[B'],
  ['Right', '\x1b[C'],
  ['Left', '\x1b[D'],
  ['Home', '\x1b[H'],
  ['End', '\x1b[F'],
  ['Delete', '\x1b[3~'],
  ['PageUp', '\x1b[5~'],
  ['PageDown', '\x1b[6~'],
  ['F1', '\x1bOP'],
  ['F5', '\x1b[15~'],
  ['F12', '\x1b[24~'],
  ['M-b (Option as Meta)', '\x1bb'],
  ['M-Enter', '\x1b\r'],
  ['C-Left', '\x1b[1;5D'],
  ['S-Up', '\x1b[1;2A'],
  ['M-Backspace', '\x1b\x7f'],
  ['UTF-8 你好', '你好'],
  ['S-Enter as CSI u', '\x1b[13;2u'],
  ['S-Enter as xterm modifyOtherKeys', '\x1b[27;2;13~'],
  ['C-j (LF)', '\n'],
];

// ---------------------------------------------------------------- 按键
{
  const p = await probe([]);
  record('keys', 'pane_key_mode (app did not request extended keys)', true, fmt(p.target, '#{pane_key_mode}'));
  for (const [name, data] of keys) {
    const got = await p.send(data);
    record('keys', name, got === hex(data) || (KNOWN.has(name) ? 'note' : false), `sent ${show(data)} -> pane got ${show(Buffer.from(got, 'hex').toString('utf8'))}`);
  }
  const burst = 'x'.repeat(2000);
  const got = await p.send(burst, 400);
  record('keys', '2000-byte burst', got === hex(burst), `pane got ${got.length / 2} bytes`);
  await p.close();
}

// 程序自己申请 modifyOtherKeys 2 时
{
  const p = await probe(['mok']);
  record('keys', 'pane_key_mode after app requests modifyOtherKeys 2', true, fmt(p.target, '#{pane_key_mode}'));
  for (const [name, data] of [['S-Enter as CSI u', '\x1b[13;2u'], ['C-c', '\x03'], ['M-b', '\x1bb'], ['Enter', '\r']]) {
    const got = await p.send(data);
    // 程序自己申请了 modifyOtherKeys 2，收到 CSI u 是它要的（claude、codex 都申请了）。
    record('keys/mok2', name, got === hex(data) || 'note', `sent ${show(data)} -> pane got ${show(Buffer.from(got, 'hex').toString('utf8'))}`);
  }
  await p.close();
}

// ---------------------------------------------------------------- 模式转发
for (const [mode, check] of [
  ['paste', (m) => m.bracketedPasteMode],
  ['appcursor', (m) => m.applicationCursorKeysMode],
  ['focus', (m) => m.sendFocusMode],
]) {
  const p = await probe([mode]);
  await sleep(100);
  const direct = await probe([mode], { direct: true });
  await sleep(100);
  record('modes', `${mode} reaches xterm`, check(p.v.term.modes) === check(direct.v.term.modes), `via tmux ${check(p.v.term.modes)}, direct ${check(direct.v.term.modes)}`);
  if (mode === 'paste') {
    const text = 'line 1\nline 2\n  indented 3';
    p.v.paste(text);
    await sleep(200);
    direct.v.paste(text);
    await sleep(200);
    const a = p.entries().map((e) => e.hex).join('');
    const b = direct.entries().map((e) => e.hex).join('');
    record('paste', 'multi-line bracketed paste', a === b, `via tmux ${show(Buffer.from(a, 'hex').toString())}`);
  }
  if (mode === 'appcursor') {
    for (const k of ['\x1bOA', '\x1bOD']) {
      const got = await p.send(k);
      record('keys/appcursor', show(k), got === hex(k), `pane got ${show(Buffer.from(got, 'hex').toString())}`);
    }
  }
  if (mode === 'focus') {
    // tmux 记着客户端的焦点状态，刚 attach 时认为已经聚焦，第一个 CSI I 不会重复转发。
    for (const k of ['\x1b[O', '\x1b[I', '\x1b[O', '\x1b[I']) {
      const got = await p.send(k);
      record('focus', show(k), got === hex(k), `pane got ${show(Buffer.from(got, 'hex').toString())}`);
    }
  }
  await p.close();
  await direct.close();
}
{
  const p = await probe([]);
  const direct = await probe([], { direct: true });
  // tmux 总是让外层打开 bracketed paste（用来识别粘贴），转给程序时再按程序的模式去掉标记，程序看不出差别。
  record('modes', 'no bracketed paste when app did not ask', p.v.term.modes.bracketedPasteMode === direct.v.term.modes.bracketedPasteMode || 'note', `via tmux ${p.v.term.modes.bracketedPasteMode}, direct ${direct.v.term.modes.bracketedPasteMode}`);
  p.v.paste('a\nb');
  const got = (await p.send('', 200));
  record('paste', 'paste without bracketed mode', got === hex('a\rb'), `pane got ${show(Buffer.from(got, 'hex').toString())}`);
  record('modes', 'xterm mouse tracking (tmux mouse on)', true, `via tmux ${p.v.term.modes.mouseTrackingMode}, direct ${direct.v.term.modes.mouseTrackingMode}`);
  await p.close();
  await direct.close();
}

// ---------------------------------------------------------------- 鼠标和滚动
const sgr = (b, x, y, release = false) => `\x1b[<${b};${x};${y}${release ? 'm' : 'M'}`;
{
  // agent 自己要鼠标：滚轮、点击原样转给它。
  const p = await probe(['mouse']);
  for (const [name, data] of [['wheel up', sgr(64, 10, 5)], ['wheel down', sgr(65, 10, 5)], ['click', sgr(0, 10, 5) + sgr(0, 10, 5, true)]]) {
    const got = await p.send(data);
    record('mouse/app-wants-mouse', name, got === hex(data), `pane got ${show(Buffer.from(got, 'hex').toString())}`);
  }
  await p.close();
}
{
  // 主屏、不要鼠标（claude、codex 的情况）：滚轮进 copy-mode 翻 tmux 历史。
  const p = await probe(['history']);
  const st = () => fmt(p.target, '#{pane_in_mode} #{scroll_position}');
  let got = await p.send(sgr(64, 10, 5));
  record('scroll/main-screen', 'wheel up enters copy-mode, nothing reaches app', got === '' && st().startsWith('1 '), `in_mode scroll_pos = ${st()}`);
  for (let i = 0; i < 4; i++) await p.send(sgr(64, 10, 5), 30);
  record('scroll/main-screen', 'wheel up x5 scrolls 3 lines each', st() === '1 15', `in_mode scroll_pos = ${st()}`);
  for (let i = 0; i < 6; i++) await p.send(sgr(65, 10, 5), 30);
  record('scroll/main-screen', 'wheel down to bottom leaves copy-mode', st().startsWith('0'), `in_mode = ${st()}`);
  await p.send(sgr(64, 10, 5));
  got = await p.send(sgr(0, 10, 5) + sgr(0, 10, 5, true));
  record('scroll/main-screen', 'click while scrolled keeps copy-mode', st().startsWith('1'), `in_mode = ${st()}, app got ${show(Buffer.from(got, 'hex').toString())}`);
  got = await p.send('x');
  record('scroll/main-screen', 'typing while scrolled leaves copy-mode', st().startsWith('0'), `in_mode = ${st()}, app got ${show(Buffer.from(got, 'hex').toString()) || '(nothing: key dropped)'}`);
  // 拖动选中 → 复制 → OSC 52
  p.v.keepRaw = true;
  p.v.raw = [];
  await p.send(sgr(64, 10, 5));
  await p.send(sgr(0, 1, 3) + sgr(32, 8, 3) + sgr(32, 14, 3) + sgr(0, 14, 3, true), 400);
  const raw = p.v.raw.join('');
  const osc52 = raw.match(/\x1b\]52;[^\x07\x1b]*;([A-Za-z0-9+/=]*)/);
  const copied = osc52 ? Buffer.from(osc52[1], 'base64').toString() : null;
  record('scroll/main-screen', 'drag-select copies via OSC 52', copied !== null && copied.startsWith('history'), `OSC 52 payload ${JSON.stringify(copied)}; tmux buffer ${JSON.stringify(tmuxOk(['show-buffer']).out.trim())}; in_mode = ${st()}`);
  await p.close();
}
{
  // 备用屏、不要鼠标（less、全屏 TUI）：滚轮变成方向键，和 xterm.js 直接跑时一样。
  const p = await probe(['alt']);
  const got = await p.send(sgr(64, 10, 5));
  const direct = await probe(['alt'], { direct: true });
  record('scroll/alt-screen', 'wheel up becomes arrow keys', got === hex('\x1b[A'.repeat(3)), `pane got ${show(Buffer.from(got, 'hex').toString())} (xterm.js itself sends arrows here: see AGENTS.md)`);
  await p.close();
  await direct.close();
}

// ---------------------------------------------------------------- Esc 延迟（escape-time 0）
{
  const measure = async (p, data, n = 20) => {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const before = p.entries().length;
      const t = (performance.timeOrigin + performance.now()) / 1000;
      p.v.write(data);
      await waitUntil(() => p.entries().length > before, 2000, 1);
      xs.push((p.entries()[before].ts - t) * 1000);
      await sleep(30);
    }
    return stats(xs);
  };
  // 不回答查询的 xterm：attach 后 5 秒内 Esc 被扣 500ms
  {
    const p = await probe([], { answerQueries: false });
    record('latency', 'Esc via tmux, xterm NOT answering XTVERSION/OSC 10/11, first 5 s after attach (ms)', 'note', JSON.stringify(await measure(p, '\x1b', 5)));
    await p.close();
  }
  const p = await probe([]);
  const d = await probe([], { direct: true });
  record('latency', 'Esc via tmux (ms)', true, JSON.stringify(await measure(p, '\x1b')));
  record('latency', 'Esc direct (ms)', true, JSON.stringify(await measure(d, '\x1b')));
  record('latency', "'a' via tmux (ms)", true, JSON.stringify(await measure(p, 'a')));
  record('latency', "'a' direct (ms)", true, JSON.stringify(await measure(d, 'a')));
  await p.close();
  await d.close();
}

// ---------------------------------------------------------------- 颜色、样式、OSC
const paint = [
  "printf '\\033[38;2;255;100;0mtruecolor fg\\033[0m \\033[48;2;20;40;60mtruecolor bg\\033[0m\\n'",
  "printf '\\033[38;5;208m256 fg\\033[0m \\033[48;5;24m256 bg\\033[0m\\n'",
  "printf '\\033[31mred\\033[0m \\033[92mbright green\\033[0m \\033[44mblue bg\\033[0m\\n'",
  "printf '\\033[1mbold\\033[0m \\033[2mdim\\033[0m \\033[3mitalic\\033[0m \\033[4munderline\\033[0m \\033[7minverse\\033[0m \\033[9mstrike\\033[0m\\n'",
  "printf '中文 ▶ ✓ ─│╭╮\\n'",
  'printf "READY\\n"',
  'exec sleep 100000',
].join('; ');
{
  newSession('colors', ['sh', '-c', paint], { cwd: PKG_DIR });
  const v = attachView('colors');
  await v.waitScreen((t) => t.includes('READY'));
  const d = new View('sh', ['-c', paint], { cwd: PKG_DIR, env: cleanEnv() });
  await d.waitScreen((t) => t.includes('READY'));
  await sleep(100);
  const a = v.colors();
  const b = d.colors();
  const same = (m1, m2) => JSON.stringify([...m1].sort()) === JSON.stringify([...m2].sort());
  record('colors', 'foreground colors', same(a.fg, b.fg), `via tmux ${JSON.stringify([...a.fg.keys()].sort())}; direct ${JSON.stringify([...b.fg.keys()].sort())}`);
  record('colors', 'background colors', same(a.bg, b.bg), `via tmux ${JSON.stringify([...a.bg.keys()].sort())}`);
  record('colors', 'attributes', same(a.attrs, b.attrs), `via tmux ${JSON.stringify([...a.attrs])}; direct ${JSON.stringify([...b.attrs])}`);
  const line = v.lines().find((l) => l.includes('中文'));
  const lineIdx = v.lines().indexOf(line);
  record('utf8', 'wide and box-drawing characters with -u', line === d.lines().find((l) => l.includes('中文')), JSON.stringify(line));
  v.kill();
  d.kill();
  // 不带 -u、也没有 LANG（从访达启动的 Electron 就是这样）
  const noLangEnv = cleanEnv();
  delete noLangEnv.LANG;
  const v2 = attachView('colors', { clientFlags: [], env: noLangEnv });
  await v2.waitScreen((t) => t.includes('READY'));
  await sleep(100);
  const line2 = v2.lines()[lineIdx];
  record('utf8', 'same, client without -u and without LANG', line2 === line || 'note', `${JSON.stringify(line2)} (this is why attach must pass -u)`);
  v2.kill();
  tmuxOk(['kill-session', '-t', '=colors']);
}
{
  // 程序发的 OSC：复制（52）、链接（8）、透传（DCS tmux;）、标题（0）、响铃
  const osc = [
    "printf '\\033]52;c;aGVsbG8=\\007'",
    "printf '\\033]8;;http://localhost:3000\\033\\\\link\\033]8;;\\033\\\\\\n'",
    "printf '\\033Ptmux;\\033\\033]9;notify me\\007\\033\\\\'",
    "printf '\\033]0;agent title\\007'",
    "printf 'bell\\007\\n'",
    'printf "READY\\n"',
    'exec sleep 100000',
  ].join('; ');
  newSession('osc', ['sh', '-c', 'sleep 0.5; ' + osc], { cwd: PKG_DIR });
  const v = attachView('osc');
  v.keepRaw = true;
  let title = null;
  v.term.onTitleChange((t) => (title = t));
  let bell = false;
  v.term.onBell(() => (bell = true));
  await v.waitScreen((t) => t.includes('READY'));
  await sleep(200);
  const raw = v.raw.join('');
  record('osc', 'OSC 52 from app reaches xterm', raw.includes('\x1b]52;c;aGVsbG8='), '');
  record('osc', 'OSC 8 hyperlink reaches xterm', /\x1b\]8;[^;]*;http:\/\/localhost:3000/.test(raw), '');
  record('osc', 'DCS passthrough (OSC 9) reaches xterm', raw.includes('\x1b]9;notify me'), '');
  record('osc', 'title reaches xterm (set-titles)', title === 'agent title', JSON.stringify(title));
  record('osc', 'bell reaches xterm', bell, '');
  v.kill();
  tmuxOk(['kill-session', '-t', '=osc']);
}

// ---------------------------------------------------------------- 输出
const width = Math.max(...results.map((r) => `${r.group} · ${r.name}`.length));
for (const r of results) {
  console.log(`${r.ok === 'note' ? 'note' : r.ok ? 'ok  ' : 'DIFF'} ${`${r.group} · ${r.name}`.padEnd(width)}  ${r.detail}`);
}
fs.rmSync(tmpDir, { recursive: true, force: true });
