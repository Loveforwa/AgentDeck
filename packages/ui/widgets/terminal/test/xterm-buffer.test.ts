// 两个 2026-10-24 验收时碰到的 xterm 问题的回归测试：
// IS-39 scrollback 为 0 时改大小，缓冲区行数可能少于屏幕行数，终端崩掉（loadCell / isWrapped）
// IS-40 字符宽度要按 Unicode 11 算，和 tmux 一致，否则 ⏺、emoji 后面的字整体错一列

import { Terminal as Headless } from '@xterm/headless';
import { createFakeApi } from '@agentdeck/fakes';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalSession } from '../src/session.ts';

const sessions: TerminalSession[] = [];
afterEach(() => {
  while (sessions.length) sessions.pop()!.dispose();
  document.body.innerHTML = '';
});

function session(): TerminalSession {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const s = new TerminalSession({ api: createFakeApi({ seed: false, silenceMs: 0 }), container, onLink: () => {}, webgl: false });
  sessions.push(s);
  return s;
}

function write(t: Headless | TerminalSession['term'], data: string): Promise<void> {
  return new Promise((resolve) => t.write(data, resolve));
}

/** 固定种子的伪随机数，让失败可以重放。 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WIDE = ['⏺', '✻', '中文字', '🙂', '◐', '⏵⏵', 'ｗｉｄｅ', '│', 'abc'];
const OPS = ['write', 'wide', 'resize', 'reset', 'clear', 'alt', 'il', 'dl', 'region'] as const;

/**
 * 模拟 tmux 往终端里写东西、同时窗口被改大小。每一步后像渲染器那样把可见的每一行读一遍，
 * 读到不存在的行就返回出事的那一步（真实应用里就是 “reading 'loadCell'”）。
 */
async function torture(scrollback: number, seed: number, rounds = 300): Promise<number | null> {
  const R = mulberry32(seed);
  const rnd = (n: number) => Math.floor(R() * n);
  const t = new Headless({ cols: 84, rows: 26, scrollback, allowProposedApi: true });
  try {
    for (let i = 0; i < rounds; i++) {
      const op = OPS[rnd(OPS.length)];
      switch (op) {
        case 'write': {
          let s = '';
          for (let k = 0; k < 4; k++) s += `\x1b[${1 + rnd(t.rows + 3)};${1 + rnd(t.cols + 3)}H` + 'x'.repeat(rnd(t.cols * 2)) + '\r\n';
          await write(t, s);
          break;
        }
        case 'wide': {
          let s = `\x1b[${1 + rnd(t.rows)};${Math.max(1, t.cols - rnd(4))}H`;
          for (let k = 0; k < 30; k++) s += WIDE[rnd(WIDE.length)];
          await write(t, s + '\r\n');
          break;
        }
        case 'resize': {
          t.resize(5 + rnd(160), 2 + rnd(60));
          const n = rnd(2) ? rnd(20) : 0;
          if (n) await write(t, WIDE.join('').repeat(n) + '\r\n');
          break;
        }
        case 'reset':
          t.reset();
          break;
        case 'clear':
          t.clear();
          break;
        case 'alt':
          await write(t, rnd(2) ? '\x1b[?1049h' : '\x1b[?1049l');
          break;
        case 'il':
          await write(t, `\x1b[${1 + rnd(t.rows)};1H\x1b[${1 + rnd(10)}L`);
          break;
        case 'dl':
          await write(t, `\x1b[${1 + rnd(t.rows)};1H\x1b[${1 + rnd(10)}M`);
          break;
        case 'region':
          await write(t, `\x1b[${1 + rnd(5)};${t.rows - rnd(3)}r\x1b[${t.rows};1H` + '\n'.repeat(rnd(40)) + '\x1b[r');
          break;
      }
      const b = t.buffer.active;
      for (let y = 0; y < t.rows; y++) if (!b.getLine(b.viewportY + y)) return i;
    }
    return null;
  } finally {
    t.dispose();
  }
}

// 这几个种子在 scrollback 为 0 时都会让缓冲区少行（2026-10-24 用 xterm 6.0.0 找到的）
const BAD_SEEDS = [1, 18, 37];

describe('IS-39: xterm buffer survives resizes', () => {
  it('the terminal window does not use scrollback 0', () => {
    expect(session().term.options.scrollback).toBeGreaterThan(0);
  });

  it('the seeds that break scrollback 0 stay healthy with our scrollback', async () => {
    const scrollback = session().term.options.scrollback ?? 0;
    for (const seed of BAD_SEEDS) expect(await torture(scrollback, seed), `seed ${seed}`).toBeNull();
  });

  it('still reproduces with scrollback 0 (if this starts passing, xterm fixed it upstream)', async () => {
    const results = await Promise.all(BAD_SEEDS.map((seed) => torture(0, seed)));
    expect(results.some((r) => r !== null)).toBe(true);
  });
});

describe('IS-40: character widths match tmux (Unicode 11)', () => {
  it('uses Unicode 11 widths', () => {
    expect(session().term.unicode.activeVersion).toBe('11');
  });

  // tmux 3.6a 实测的宽度（2026-10-24，在 tmux 里 printf 每个字符后读 cursor_x）。xterm 默认的 Unicode 6 把这里所有 emoji 都算成 1。
  const TMUX_WIDTHS: [string, number][] = [
    ['⏺', 1], ['✻', 1], ['◐', 1], ['⏵', 1], ['❯', 1], ['⎿', 1], ['✳', 1], ['⏸', 1], ['▛', 1], ['⚠', 1], ['✓', 1], ['☐', 1], ['⌘', 1],
    ['中', 2], ['🙂', 2], ['🤖', 2], ['✅', 2], ['❌', 2], ['👍', 2], ['⚡', 2], ['⏳', 2],
  ];

  it('every symbol claude uses takes as many columns as tmux gives it', async () => {
    const t = session().term;
    for (const [text, cols] of TMUX_WIDTHS) {
      await write(t, '\x1b[H\x1b[2K' + text);
      expect(t.buffer.active.cursorX, text).toBe(cols);
    }
  });
});
