// F7 试验脚本共用的工具：起 AgentDeck 的 tmux、用 node-pty + @xterm/headless 模拟界面里的终端。
//
// 依赖 node-pty 和 @xterm/headless，不装进仓库（避免改根目录的 lockfile），
// 由 trial.sh 装到 AGENTDECK_TRIAL_DEPS 指向的缓存目录。
// 和第 2 波的真实界面一样：node-pty 起 `tmux attach`，输出写进 xterm，
// xterm 对查询序列（DA、CPR 等）的应答写回 pty。

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PKG_DIR = path.resolve(here, '..');
export const CONF = process.env.AGENTDECK_TMUX_CONF ?? path.join(PKG_DIR, 'tmux.conf');
export const TMUX = process.env.AGENTDECK_TMUX ?? 'tmux';
export const SOCKET = 'agentdeck';

const deps = process.env.AGENTDECK_TRIAL_DEPS;
if (!deps) throw new Error('AGENTDECK_TRIAL_DEPS is not set; run through trial.sh');
const req = createRequire(path.join(deps, 'package.json'));
export const pty = req('node-pty');
export const { Terminal } = req('@xterm/headless');

/**
 * tmux 服务和 agent 进程用的干净环境。
 * 不能把启动者（Electron、或者这里的 Claude Code）的环境整个带进去：
 * tmux 服务的全局环境取自第一次启动它的进程，例如 CLAUDECODE=1 会让窗格里的 claude 以为自己是嵌套的。
 */
export function cleanEnv(extra = {}) {
  const keep = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  env.LANG = process.env.AGENTDECK_TRIAL_LANG ?? 'en_US.UTF-8';
  env.TERM = 'xterm-256color';
  return { ...env, ...extra };
}

export function tmux(args, opts = {}) {
  return execFileSync(TMUX, ['-L', SOCKET, '-f', CONF, ...args], {
    env: cleanEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

export function tmuxOk(args) {
  try {
    return { ok: true, out: tmux(args) };
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? e.message) };
  }
}

export function killServer() {
  tmuxOk(['kill-server']);
}

/** 新建会话，和 tmux-host 的 create() 将来的做法一致：-e 设 AGENTDECK_TERM，直接 exec 命令（不经 shell）。 */
export function newSession(id, argv, { cwd = process.cwd(), cols = 120, rows = 32, env = {} } = {}) {
  // 上一次试验中途退出时可能留下同名会话。
  tmuxOk(['kill-session', '-t', `=${id}`]);
  const envArgs = Object.entries({ AGENTDECK_TERM: id, ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  tmux(['new-session', '-d', '-s', id, '-x', String(cols), '-y', String(rows), '-c', cwd, ...envArgs, '--', ...argv]);
}

export function fmt(target, format) {
  return tmux(['display-message', '-p', '-t', target, format]).replace(/\n$/, '');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(pred, timeoutMs = 5000, stepMs = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await pred();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

/**
 * 一个“界面里的终端”：node-pty 进程 + 无界面的 xterm。
 * 和 T2 的终端窗口一样：xterm 收输出，xterm 的 onData（键入、查询应答）写回 pty。
 */
export class View {
  constructor(file, args, { cols = 120, rows = 32, env = cleanEnv(), cwd = process.cwd(), scrollback = 1000, answerQueries = true } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.startedAt = performance.now();
    this.firstDataAt = null;
    this.bytes = 0;
    this.raw = [];
    this.keepRaw = false;
    this.listeners = new Set();
    this.p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
    this.exited = new Promise((resolve) => {
      this.p.onExit((e) => {
        this.exitedAt = performance.now();
        resolve(e);
      });
    });
    this.p.onData((d) => {
      if (this.firstDataAt === null) this.firstDataAt = performance.now();
      this.bytes += d.length;
      if (this.keepRaw) this.raw.push(d);
      this.term.write(d, () => {
        for (const l of this.listeners) l();
      });
    });
    this.term.onData((d) => this.write(d));
    if (answerQueries) installQueryAnswers(this.term, (d) => this.write(d));
  }

  write(data) {
    if (this.exitedAt !== undefined) return;
    try {
      this.p.write(data);
    } catch {
      // pty 已经关了（例如 kill 之后 xterm 还在回答查询）
    }
  }

  /** 模拟 xterm.js 的粘贴：按当前 bracketed paste 模式决定是否加标记，换行转成 CR。 */
  paste(text) {
    const body = text.replace(/\r?\n/g, '\r');
    if (this.term.modes.bracketedPasteMode) this.write(`\x1b[200~${body}\x1b[201~`);
    else this.write(body);
  }

  lines() {
    const buf = this.term.buffer.active;
    const out = [];
    for (let y = 0; y < this.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      out.push(line ? line.translateToString(true) : '');
    }
    return out;
  }

  text() {
    return this.lines().join('\n');
  }

  /** 屏幕上出现过的前景色、背景色集合，用来对比“直接跑”和“经过 tmux”。 */
  colors() {
    const buf = this.term.buffer.active;
    const cell = buf.getNullCell();
    const fg = new Map();
    const bg = new Map();
    const attrs = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
    for (let y = 0; y < this.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line) continue;
      for (let x = 0; x < this.cols; x++) {
        line.getCell(x, cell);
        const ch = cell.getChars();
        const fgk = cell.isFgRGB() ? `rgb:${cell.getFgColor().toString(16).padStart(6, '0')}` : cell.isFgPalette() ? `p:${cell.getFgColor()}` : 'default';
        const bgk = cell.isBgRGB() ? `rgb:${cell.getBgColor().toString(16).padStart(6, '0')}` : cell.isBgPalette() ? `p:${cell.getBgColor()}` : 'default';
        if (ch && ch !== ' ') bump(fg, fgk);
        bump(bg, bgk);
        for (const [name, on] of [['bold', cell.isBold()], ['dim', cell.isDim()], ['italic', cell.isItalic()], ['underline', cell.isUnderline()], ['inverse', cell.isInverse()], ['strike', cell.isStrikethrough()]]) {
          if (on) bump(attrs, name);
        }
      }
    }
    return { fg, bg, attrs };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 等屏幕满足条件；每次 xterm 处理完一段输出都检查一次。返回满足时的时间点。 */
  waitScreen(pred, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const check = () => {
        if (pred(this.text(), this)) {
          off();
          clearTimeout(timer);
          resolve(performance.now());
          return true;
        }
        return false;
      };
      const off = this.onChange(check);
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
      check();
    });
  }

  kill(signal) {
    try {
      this.p.kill(signal);
    } catch {
      // 已经退出
    }
  }
}

/**
 * xterm.js 自己不回答的几个查询，T2 的终端窗口必须补上（见 AGENTS.md「Esc 延迟 500ms」）。
 * tmux 每次 attach 都会发 XTVERSION（CSI > q）和 OSC 10/11（前景、背景色）查询，
 * 收不到回答时，attach 后的 5 秒内单独按 Esc 会被 tmux 扣住 500ms 才交给 agent。
 * CSI ? 996 n（深浅色主题）不影响 Esc，顺手回答，颜色取 tokens 里的墨黑和暖灰。
 */
export function installQueryAnswers(term, write, { fg = '1a1a/1a1a/1a1a', bg = 'f7f7/f7f7/f5f5', dark = false } = {}) {
  term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => {
    write('\x1bP>|xterm.js\x1b\\');
    return true;
  });
  for (const [n, rgb] of [[10, fg], [11, bg]]) {
    term.parser.registerOscHandler(n, (data) => {
      if (data !== '?') return false;
      write(`\x1b]${n};rgb:${rgb}\x1b\\`);
      return true;
    });
  }
  term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
    if (params[0] !== 996) return false;
    write(`\x1b[?997;${dark ? 1 : 2}n`);
    return true;
  });
}

/** 外层（xterm.js）的能力，attach 时用 -T 声明，见 tmux.conf。 */
export const CLIENT_FEATURES = 'RGB,extkeys,hyperlinks,sync,strikethrough,usstyle,overline';

/** 经过 AgentDeck 的 tmux attach 到一个会话（T2 将来的做法）。-u：强制按 UTF-8 处理，见 AGENTS.md。 */
export function attachView(id, opts = {}) {
  const extra = opts.clientFlags ?? ['-u', '-T', CLIENT_FEATURES];
  return new View(TMUX, ['-L', SOCKET, '-f', CONF, ...extra, 'attach-session', '-t', `=${id}`], opts);
}

export function stats(xs) {
  const a = xs.filter((x) => x != null).sort((p, q) => p - q);
  if (a.length === 0) return { n: 0 };
  const q = (f) => a[Math.min(a.length - 1, Math.floor(f * a.length))];
  const r = (x) => Math.round(x * 10) / 10;
  return { n: a.length, median: r(a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2), p90: r(q(0.9)), min: r(a[0]), max: r(a[a.length - 1]) };
}

export const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
export const show = (s) => JSON.stringify(s).slice(1, -1);
