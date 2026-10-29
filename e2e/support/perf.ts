// IS-26 性能测量（B1 平移不掉帧、T2 打字延迟、G4 空闲 CPU）用的小工具。只给 is26-performance.e2e.ts 用。
// - 统计：p50 / p95 / max。
// - 机器负载：同时还有别的 e2e 线在这台机器上跑，数字旁边要写当时的负载（整机 CPU 忙的比例、loadavg、别的 AgentDeck e2e 实例数）。
// - 帧：页面里用 requestAnimationFrame 记每一帧的开始时间，加 long-animation-frame（LoAF）记下慢帧里是哪段脚本。
// - 进程 CPU：主进程里 app.getAppMetrics() 的 cumulativeCPUUsage（秒）差值；tmux 服务和它下面的进程用 ps 的 CPU 时间。
// 只读，不改产品代码。
import { spawnSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import type { Page } from '@playwright/test';
import type { Deck } from './deck.ts';

export interface Stats {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export function stats(values: number[]): Stats {
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)]! : 0);
  const round = (x: number) => Math.round(x * 100) / 100;
  return { n: v.length, p50: round(q(0.5)), p95: round(q(0.95)), max: round(v[v.length - 1] ?? 0), mean: round(v.reduce((a, b) => a + b, 0) / (v.length || 1)) };
}

// ---- 机器负载 ----

export interface MachineLoad {
  /** 测量这段时间里整机 CPU 忙的比例（所有核平均，0–100）。 */
  busyPct: number;
  cores: number;
  loadavg1: number;
  /** 这段时间里同时开着的别的 AgentDeck e2e 实例（别的验收线），不算自己。 */
  otherE2eApps: number;
}

function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}

/** 别的 AgentDeck e2e 实例：Electron 主进程（不算 Electron Helper 子进程），命令行里有 --user-data-dir=…agentdeck-e2e-…，不是自己的沙盒。 */
export function otherE2eApps(ownRoot: string): number {
  const out = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout;
  return out
    .split('\n')
    .filter((l) => /\/Electron\.app\/Contents\/MacOS\/Electron /.test(l) && !l.includes('--type=') && /--user-data-dir=\S*agentdeck-e2e-/.test(l) && !l.includes(ownRoot)).length;
}

/** 开始记机器负载，stop() 返回这段时间的平均。 */
export function loadSampler(ownRoot: string): { stop(): MachineLoad } {
  const start = cpuTimes();
  const others: number[] = [otherE2eApps(ownRoot)];
  const timer = setInterval(() => others.push(otherE2eApps(ownRoot)), 2000);
  return {
    stop() {
      clearInterval(timer);
      const end = cpuTimes();
      const busyPct = Math.round(((end.busy - start.busy) / Math.max(1, end.total - start.total)) * 1000) / 10;
      return { busyPct, cores: cpus().length, loadavg1: Math.round(loadavg()[0]! * 100) / 100, otherE2eApps: Math.max(...others) };
    },
  };
}

// ---- 帧 ----

export interface LongFrame {
  start: number;
  duration: number;
  blocking: number;
  /** 这一帧里最长的几段脚本：invoker（谁调的）、源文件名、函数名、毫秒。 */
  scripts: { invoker: string; source: string; fn: string; ms: number }[];
}

export interface FrameRecord {
  /** rAF 的时间戳（毫秒，performance.now 的时间轴）。 */
  frames: number[];
  longFrames: LongFrame[];
  hidden: boolean;
}

/** 页面里开始记帧（rAF 时间戳 + LoAF）。 */
export async function startFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Loaf = PerformanceEntry & {
      blockingDuration: number;
      scripts: { invoker: string; sourceURL: string; sourceFunctionName: string; duration: number }[];
    };
    const w = window as unknown as { __is26Frames?: { frames: number[]; longFrames: unknown[]; running: boolean; hidden: boolean; obs: PerformanceObserver | null } };
    const rec = { frames: [] as number[], longFrames: [] as unknown[], running: true, hidden: document.visibilityState !== 'visible', obs: null as PerformanceObserver | null };
    w.__is26Frames = rec;
    const loop = (t: number) => {
      if (!rec.running) return;
      rec.frames.push(t);
      if (document.visibilityState !== 'visible') rec.hidden = true;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    try {
      rec.obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as Loaf[]) {
          rec.longFrames.push({
            start: Math.round(e.startTime),
            duration: Math.round(e.duration),
            blocking: Math.round(e.blockingDuration),
            scripts: [...e.scripts]
              .sort((a, b) => b.duration - a.duration)
              .slice(0, 3)
              .map((s) => ({ invoker: s.invoker, source: (s.sourceURL || '').split('/').pop() ?? '', fn: s.sourceFunctionName, ms: Math.round(s.duration) })),
          });
        }
      });
      rec.obs.observe({ type: 'long-animation-frame', buffered: false });
    } catch {
      // 没有 LoAF 时只记帧
    }
  });
}

export async function stopFrames(page: Page): Promise<FrameRecord> {
  return page.evaluate(() => {
    const w = window as unknown as { __is26Frames: { frames: number[]; longFrames: LongFrame[]; running: boolean; hidden: boolean; obs: PerformanceObserver | null } };
    const rec = w.__is26Frames;
    rec.running = false;
    rec.obs?.disconnect();
    return { frames: rec.frames, longFrames: rec.longFrames, hidden: rec.hidden };
  });
}

/** 静止时的帧间隔中位数：显示器的刷新间隔（60Hz ≈ 16.7ms，120Hz ≈ 8.3ms）。 */
export async function vsyncInterval(page: Page, ms = 1000): Promise<number> {
  await startFrames(page);
  await page.waitForTimeout(ms);
  const rec = await stopFrames(page);
  return stats(intervals(rec.frames)).p50;
}

export function intervals(frames: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < frames.length; i++) out.push(frames[i]! - frames[i - 1]!);
  return out;
}

export interface FrameSummary extends Stats {
  vsync: number;
  /** 晚了的帧（间隔 > 1.5 个刷新间隔）。 */
  late: number;
  /** 掉了几帧（每个间隔按刷新间隔数，多出来的算掉帧）。 */
  dropped: number;
  /** 掉帧占应有帧数的比例（%）。 */
  droppedPct: number;
  /** 超过 50ms 的帧（LoAF 报的）。 */
  longFrames: number;
}

export function summarizeFrames(frames: number[], vsync: number, longFrames: LongFrame[]): FrameSummary {
  const iv = intervals(frames);
  let dropped = 0;
  let late = 0;
  for (const d of iv) {
    if (d > vsync * 1.5) late++;
    dropped += Math.max(0, Math.round(d / vsync) - 1);
  }
  const expected = iv.length + dropped;
  return { ...stats(iv), vsync, late, dropped, droppedPct: Math.round((dropped / Math.max(1, expected)) * 1000) / 10, longFrames: longFrames.length };
}

/** 慢帧里出现最多的脚本（按总毫秒排），报告里说明“慢在哪”。 */
export function topScripts(longFrames: LongFrame[], n = 5): { key: string; ms: number; frames: number }[] {
  const acc = new Map<string, { ms: number; frames: number }>();
  for (const f of longFrames) {
    for (const s of f.scripts) {
      const key = `${s.invoker} ${s.source}${s.fn ? `:${s.fn}` : ''}`;
      const a = acc.get(key) ?? { ms: 0, frames: 0 };
      a.ms += s.ms;
      a.frames++;
      acc.set(key, a);
    }
  }
  return [...acc.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, n);
}

// ---- 进程 CPU ----

export interface ProcessCpu {
  type: string;
  name: string;
  pid: number;
  /** 累计 CPU 秒。 */
  cpuSec: number;
  idleWakeups: number;
}

export async function appProcesses(deck: Deck): Promise<ProcessCpu[]> {
  return deck.app.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({
      type: m.type,
      name: m.name ?? m.serviceName ?? '',
      pid: m.pid,
      cpuSec: m.cpu.cumulativeCPUUsage ?? 0,
      idleWakeups: m.cpu.idleWakeupsPerSecond,
    })),
  );
}

/** ps 的 CPU 时间（“1:02.34”、“1:02:03.45” 或 “1-02:03:04”）→ 秒。 */
export function parseCpuTime(s: string): number {
  let days = 0;
  let rest = s.trim();
  const dash = rest.indexOf('-');
  if (dash > 0) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(':').map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return days * 86400 + sec;
}

/** 一个进程和它下面所有进程的 CPU 秒（ps），按 pid。 */
export function treeCpu(rootPid: number): Map<number, { cpuSec: number; command: string }> {
  const out = spawnSync('ps', ['-axo', 'pid=,ppid=,time=,command='], { encoding: 'utf8' }).stdout;
  const rows = out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cpuSec: parseCpuTime(m[3]!), command: m[4]! }));
  const keep = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (!keep.has(r.pid) && keep.has(r.ppid)) {
        keep.add(r.pid);
        grew = true;
      }
    }
  }
  return new Map(rows.filter((r) => keep.has(r.pid)).map((r) => [r.pid, { cpuSec: r.cpuSec, command: r.command }]));
}

// ---- xterm ----

/**
 * 在页面里给窗口的 xterm 挂上打字延迟的测量（T2）：
 * - t0：按键的 keydown 到达页面（捕获阶段，比 xterm 早）；
 * - t1：回显的字解析进 xterm 缓冲区（onWriteParsed 后光标所在行以“到现在为止打的字”结尾）；
 * - t2：之后 xterm 第一次画（onRender），也就是画面上出现这个字的那一帧。
 * 终端对象从 .xterm 元素的 React fiber 找（和 support/g1.ts 的 xtermOf 一样）。
 */
export async function hookTyping(page: Page, windowIds: string[]): Promise<void> {
  await page.evaluate((ids) => {
    type Fiber = { memoizedState: unknown; return: Fiber | null };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Term = {
      buffer: { active: { baseY: number; cursorY: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined } };
      onWriteParsed(cb: () => void): unknown;
      onRender(cb: () => void): unknown;
    };
    const find = (id: string): Term | null => {
      const el = document.querySelector(`.ad-window-node[data-window-id="${id}"] .xterm`);
      let node: Element | null = el;
      let key: string | undefined;
      while (node && !(key = Object.keys(node).find((k) => k.startsWith('__reactFiber$')))) node = node.parentElement;
      if (!node || !key) return null;
      let f = (node as unknown as Record<string, Fiber>)[key] ?? null;
      for (let depth = 0; f && depth < 80; depth++, f = f.return) {
        let h = f.memoizedState as Hook | null;
        for (let i = 0; h && i < 80; i++, h = h.next) {
          const v = h.memoizedState as { current?: { term?: Term } } | null;
          if (v && typeof v === 'object' && 'current' in v && v.current && typeof v.current === 'object' && v.current.term) return v.current.term;
        }
      }
      return null;
    };
    type Pending = { windowId: string; key: string; expect: string; t0: number | null; t1: number | null };
    const st = { pending: null as Pending | null, results: [] as { windowId: string; parsed: number; painted: number }[] };
    (window as unknown as { __is26Typing: typeof st }).__is26Typing = st;
    window.addEventListener(
      'keydown',
      (e) => {
        const p = st.pending;
        if (p && p.t0 === null && e.key === p.key) p.t0 = performance.now();
      },
      true,
    );
    for (const id of ids) {
      const term = find(id);
      if (!term) throw new Error(`no xterm in window ${id}`);
      term.onWriteParsed(() => {
        const p = st.pending;
        if (!p || p.windowId !== id || p.t0 === null || p.t1 !== null) return;
        const buf = term.buffer.active;
        const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? '';
        if (line.endsWith(p.expect)) p.t1 = performance.now();
      });
      term.onRender(() => {
        const p = st.pending;
        if (!p || p.windowId !== id || p.t0 === null || p.t1 === null) return;
        const t2 = performance.now();
        st.results.push({ windowId: id, parsed: p.t1 - p.t0, painted: t2 - p.t0 });
        st.pending = null;
      });
    }
  }, windowIds);
}

/** 打一个字（真的键盘，经 CDP → xterm → IPC → tmux → 程序回显 → xterm），等它画出来，返回 { parsed, painted } 毫秒。 */
export async function typeAndMeasure(page: Page, windowId: string, key: string, expectSuffix: string): Promise<{ parsed: number; painted: number }> {
  await page.evaluate(
    ({ windowId, key, expectSuffix }) => {
      (window as unknown as { __is26Typing: { pending: unknown } }).__is26Typing.pending = { windowId, key, expect: expectSuffix, t0: null, t1: null };
    },
    { windowId, key, expectSuffix },
  );
  await page.keyboard.press(key);
  const handle = await page.waitForFunction(
    () => {
      const st = (window as unknown as { __is26Typing: { pending: unknown; results: { parsed: number; painted: number }[] } }).__is26Typing;
      return st.pending === null ? st.results[st.results.length - 1]! : null;
    },
    null,
    { timeout: 10_000, polling: 'raf' },
  );
  return (await handle.jsonValue()) as { parsed: number; painted: number };
}
