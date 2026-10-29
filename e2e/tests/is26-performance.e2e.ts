// IS-26：三项性能完成标准在组装好的真应用里量一遍（Playwright 的 Electron 模式，真 tmux，假 agent）。
// - B1：白板上 30 个窗口（20 个有输出的终端，其中 3 个一直在打印；10 个网页窗口），真的鼠标拖空白处平移，
//       页面里用 requestAnimationFrame 记帧间隔，算 p50 / p95 / max 和掉帧比例；long-animation-frame 记下慢帧里的脚本。
// - T2：6 个终端（4 个假 claude + 2 个 bash）都在视口里、都接上了显示，真的键盘一个字一个字打，
//       量“keydown 到达页面 → 回显的字进 xterm 缓冲区 → 画出来”的时间；第二段让两个 bash 一直打印，再量一次。
// - G4：框里 6 个空闲终端 + 1 个网页、Source Control 面板开着，不动 60 秒，量应用每个进程（主进程、界面、GPU、utility……）
//       和 tmux 服务那一串进程的平均 CPU；再拿掉左下角的 Clawd、开 reduced motion 各量 30 秒，找是谁在耗。
// 这台机器上同时还跑着别的 e2e 线：每个数字旁边打印当时的机器负载（整机 CPU 忙的比例、loadavg、别的 AgentDeck e2e 实例数）。
// 慢、而且对负载敏感，默认的 `pnpm e2e` 不跑：AGENTDECK_E2E_PERF=1 才跑（见 e2e/AGENTS.md）。
// 结果每条打印一行 `[IS-26] {...}`，也附在报告里（is26-*.json）。
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal, setupWorktree } from '../support/flows.ts';
import { invokes, recordInvokes, clearInvokes } from '../support/g1.ts';
import {
  appProcesses,
  hookTyping,
  loadSampler,
  startFrames,
  stats,
  stopFrames,
  summarizeFrames,
  topScripts,
  treeCpu,
  typeAndMeasure,
  vsyncInterval,
  type MachineLoad,
} from '../support/perf.ts';
import { makeRepo } from '../support/repo.ts';
import { E2E_DIR } from '../support/sandbox.ts';

test.skip(process.env['AGENTDECK_E2E_PERF'] !== '1', 'performance measurements: set AGENTDECK_E2E_PERF=1');

// 别的 AgentDeck 窗口（别的 e2e 线）盖住这个窗口时，Chromium 会把它当成看不见、停掉 rAF 和绘制；测的是应用自己，不是被盖住时的节流
const LAUNCH_ARGS = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function devServer(): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const proc = spawn(process.execPath, [join(E2E_DIR, 'fake-agent/dev-server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    proc.once('error', reject);
    proc.stdout!.on('data', (c: Buffer) => {
      if (c.toString().includes('Local:')) resolve();
    });
  });
  return { url: `http://localhost:${port}/`, proc };
}

function report(info: TestInfo, name: string, data: Record<string, unknown>): void {
  console.log(`[IS-26] ${JSON.stringify({ name, ...data })}`);
  void info.attach(`is26-${name}.json`, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
}

/** 准备场景：用 tmux send-keys 在终端里跑一条命令（不是被测的步骤）。 */
function run(deck: Deck, terminalId: string, command: string): void {
  deck.sb.tmux(['send-keys', '-t', `=${terminalId}:`, '-l', command]);
  deck.sb.tmux(['send-keys', '-t', `=${terminalId}:`, 'Enter']);
}

async function setViewport(page: Page, vp: { x: number; y: number; zoom: number }): Promise<void> {
  await page.evaluate((vp) => {
    const c = (window as unknown as { __board: { setViewport(v: object, d: number): void; focusWindow(id: null): void } }).__board;
    c.focusWindow(null);
    c.setViewport(vp, 0);
  }, vp);
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __board: { state: { viewport: { zoom: number } } } }).__board.state.viewport.zoom)).toBeCloseTo(vp.zoom, 3);
}

/** 白板空白处按下，分 steps 步、每步 stepMs 毫秒拖 (dx, dy)，松开（真的鼠标，React Flow 的拖动平移）。 */
async function dragPan(deck: Deck, dx: number, dy: number, steps = 40, stepMs = 16): Promise<void> {
  const page = deck.page;
  const pane = await page.locator('.react-flow__pane').boundingBox();
  if (!pane) throw new Error('no board pane');
  const from = await deck.emptyPoint(dx < 0 ? 'right' : dy < 0 ? 'bottom' : 'left');
  // 终点留在白板里
  const tx = Math.min(pane.x + pane.width - 10, Math.max(pane.x + 10, from.x + dx));
  const ty = Math.min(pane.y + pane.height - 10, Math.max(pane.y + 10, from.y + dy));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((tx - from.x) * i) / steps, from.y + ((ty - from.y) * i) / steps);
    const wait = t0 + i * stepMs - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
  }
  await page.mouse.up();
}

const PAN_PATH: [number, number][] = [
  [-500, 0],
  [-500, 0],
  [-500, 0],
  [-500, 0],
  [0, -350],
  [500, 0],
  [500, 0],
  [500, 0],
  [500, 0],
  [0, -350],
  [-500, 0],
  [-500, 0],
];

test('IS-26 B1 pan a board with 30 windows (20 terminals with output, 10 browser windows) without dropping frames', async ({ deck }, info) => {
  test.setTimeout(300_000);
  const page = await deck.launch({ args: LAUNCH_ARGS });
  const server = await devServer();
  try {
    // 30 个窗口排成 6 × 5 的格子，窗口之间留空（拖空白处平移要有空白处）
    const at = (i: number) => ({ x: (i % 6) * 760, y: Math.floor(i / 6) * 520 });
    const terminals: { windowId: string; terminalId: string }[] = [];
    const browsers: string[] = [];
    for (let i = 0; i < 30; i++) {
      if (i % 3 === 2) {
        const id = await page.evaluate(
          ({ url, rect }) =>
            (window as unknown as { __board: { openWindow(f: null, r: object, o: object): string | null } }).__board.openWindow(
              null,
              { type: 'browser', workspaceId: null, data: { url, mode: 'frame' }, rect },
              { quiet: true },
            ),
          { url: server.url, rect: at(i) },
        );
        if (!id) throw new Error('could not open a browser window');
        browsers.push(id);
      } else {
        terminals.push(await openTerminal(deck, null, 'shell', undefined, at(i)));
      }
    }
    // 终端里有输出：17 个打一屏文件列表，3 个一直在打印（像在跑的 agent）
    const streaming = [0, 7, 14].map((i) => terminals[i]!);
    for (const t of terminals) {
      if (streaming.includes(t)) run(deck, t.terminalId, 'while :; do echo "$(date +%T) tick $RANDOM $RANDOM $RANDOM $RANDOM"; sleep 0.1; done');
      else run(deck, t.terminalId, 'ls -la /usr/bin | head -40');
    }
    for (const t of terminals) await deck.waitForPane(t.terminalId, streaming.includes(t) ? /tick \d+/ : /total \d+|root/);
    const b = await deck.board();
    expect(b.windows.length).toBe(30);
    expect(b.windows.filter((w) => w.type === 'terminal').length).toBe(20);
    expect(b.windows.filter((w) => w.type === 'browser').length).toBe(10);
    await recordInvokes(deck);

    const vsync = await vsyncInterval(page);
    const results: Record<string, unknown>[] = [];
    for (const zoom of [1, 0.6]) {
      await setViewport(page, { x: 40, y: 60, zoom });
      // 视口里的终端接上、网页画出来
      await expect.poll(() => page.locator('.ad-window-node .xterm').count(), { timeout: 30_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(1500);
      await deck.screenshot(`zoom-${zoom}-before-pan`);
      await clearInvokes(deck);
      const load = loadSampler(deck.sb.root);
      await startFrames(page);
      const t0 = Date.now();
      let travelled = 0;
      for (const [dx, dy] of PAN_PATH) {
        const before = (await deck.board()).viewport;
        await dragPan(deck, dx, dy);
        const after = (await deck.board()).viewport;
        travelled += Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
      }
      const rec = await stopFrames(page);
      const ms = Date.now() - t0;
      const machine: MachineLoad = load.stop();
      await deck.screenshot(`zoom-${zoom}-after-pan`);
      const calls = await invokes(deck);
      const summary = summarizeFrames(rec.frames, vsync, rec.longFrames);
      const r = {
        zoom,
        panMs: ms,
        travelledPx: Math.round(travelled),
        frames: summary,
        hidden: rec.hidden,
        attaches: calls.filter((c) => c.call === 'terminals.attach').length,
        detaches: calls.filter((c) => c.call === 'terminals.detach').length,
        topLongFrameScripts: topScripts(rec.longFrames),
        worstFrames: [...rec.longFrames].sort((a, b) => b.duration - a.duration).slice(0, 3),
        machine,
      };
      report(info, `B1-zoom-${zoom}`, r);
      results.push(r);
      // 真的平移了（视口跟着拖动走了）
      expect(travelled, 'viewport followed the drags').toBeGreaterThan(3000 * zoom);
      expect(rec.hidden, 'the window stayed visible while measuring').toBe(false);
    }
    // B1 的完成标准“平移不掉帧”，按这几条判：掉帧 ≤ 5%、p95 ≤ 1.5 个刷新间隔、最长一帧 ≤ 100ms
    for (const r of results as { zoom: number; frames: ReturnType<typeof summarizeFrames> }[]) {
      expect.soft(r.frames.droppedPct, `zoom ${r.zoom}: dropped-frame share (%)`).toBeLessThanOrEqual(5);
      expect.soft(r.frames.p95, `zoom ${r.zoom}: p95 frame time (ms)`).toBeLessThanOrEqual(vsync * 1.5);
      expect.soft(r.frames.max, `zoom ${r.zoom}: longest frame (ms)`).toBeLessThanOrEqual(100);
    }
  } finally {
    server.proc.kill();
  }
});

test('IS-26 T2 typing latency with 6 terminals open (4 fake claude + 2 bash)', async ({ deck }, info) => {
  test.setTimeout(300_000);
  const page = await deck.launch({ args: LAUNCH_ARGS });
  // 3 × 2 排开，⌘1 后都在视口里、都不是摘要卡（缩放 ≥ 0.5）
  const at = (i: number) => ({ x: (i % 3) * 600, y: Math.floor(i / 3) * 400 });
  const claudes: { windowId: string; terminalId: string }[] = [];
  const shells: { windowId: string; terminalId: string }[] = [];
  for (let i = 0; i < 6; i++) {
    const t = await openTerminal(deck, null, i < 4 ? 'claude' : 'shell', undefined, at(i));
    (i < 4 ? claudes : shells).push(t);
  }
  for (const t of claudes) {
    await deck.waitForPane(t.terminalId, /Fake Claude/);
    await deck.waitForStatus(t.terminalId, 'idle');
  }
  for (const t of shells) await deck.waitForPane(t.terminalId, /e2e\$ *$/m);
  await deck.showAll();
  const all = [...claudes, ...shells];
  // 6 个都接上了显示（视口里、不是摘要卡）
  for (const t of all) await expect(deck.windowEl(t.windowId).locator('.xterm')).toHaveCount(1);
  expect((await deck.board()).viewport.zoom).toBeGreaterThanOrEqual(0.5);
  await expect.poll(() => deck.sb.tmux(['list-clients', '-F', '#{client_session}']).stdout.split('\n').filter(Boolean).length).toBe(6);
  await hookTyping(page, all.map((t) => t.windowId));
  await deck.screenshot('six-terminals');

  const letters = 'bcfghjkmpqrsuvwxyz';
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  /** 轮流在 targets 里每个终端打 perTerminal 个字（每打 20 个按一次回车，不计时），返回每个字的 { parsed, painted }。 */
  async function typeRound(targets: { windowId: string; terminalId: string }[], perTerminal: number) {
    const samples: { windowId: string; parsed: number; painted: number }[] = [];
    for (const t of targets) {
      await deck.focusWindow(t.windowId);
      let line = '';
      for (let i = 0; i < perTerminal; i++) {
        const ch = letters[Math.floor(rand() * letters.length)]!;
        line += ch;
        const r = await typeAndMeasure(page, t.windowId, ch, line);
        samples.push({ windowId: t.windowId, ...r });
        // 像人打字：字和字之间 40–100ms
        await page.waitForTimeout(40 + Math.floor(rand() * 60));
        if (line.length >= 20) {
          await page.keyboard.press('Enter');
          line = '';
          await page.waitForTimeout(300);
        }
      }
      if (line) {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
      }
    }
    return samples;
  }

  const rounds: Record<string, unknown>[] = [];
  // 第一段：6 个终端都空闲，轮流在每个里打 30 个字
  {
    const load = loadSampler(deck.sb.root);
    const s = await typeRound(all, 30);
    const machine = load.stop();
    const r = { phase: 'all idle', parsed: stats(s.map((x) => x.parsed)), painted: stats(s.map((x) => x.painted)), machine };
    report(info, 'T2-idle', r);
    rounds.push(r);
  }
  // 第二段：两个 bash 一直打印（每 50ms 一行），在 4 个假 claude 里轮流打 40 个字
  for (const t of shells) run(deck, t.terminalId, 'while :; do echo "tick $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM"; sleep 0.05; done');
  for (const t of shells) await deck.waitForPane(t.terminalId, /tick \d+/);
  {
    const load = loadSampler(deck.sb.root);
    const s = await typeRound(claudes, 40);
    const machine = load.stop();
    const r = { phase: '2 terminals streaming', parsed: stats(s.map((x) => x.parsed)), painted: stats(s.map((x) => x.painted)), machine };
    report(info, 'T2-streaming', r);
    rounds.push(r);
  }
  await deck.screenshot('after-typing');
  // 回显真的进了程序：假 claude 收到了打的那几行
  for (const t of claudes) expect(deck.agentLog(t.terminalId).some((e) => e.kind === 'input' && /^[a-z]{20}$/.test(e.line ?? ''))).toBe(true);
  // T2 的完成标准“打字无可感知延迟”：按键到画出来 p95 ≤ 50ms
  for (const r of rounds as { phase: string; painted: { p95: number } }[]) {
    expect.soft(r.painted.p95, `${r.phase}: key → painted p95 (ms)`).toBeLessThanOrEqual(50);
  }
});

test('IS-26 G4 idle CPU with the board open and terminals idle', async ({ deck, sb }, info) => {
  test.setTimeout(300_000);
  // 2026-10-29 量出来不达标（IS-161）：左下角 Clawd 的两帧用无限循环的 CSS 动画交替，缩回去以后精灵也一直挂着，
  // 界面进程和 GPU 一直出帧，应用合计 3.0–4.6% 一个核。白板每出一帧都不便宜，Clawd 露面时的升降和换帧本身就约 2.5%，
  // 所以修法是：换帧改成露着时的定时器、缩回去就卸掉，键盘鼠标 30 秒没动（人走开了）就不再冒出来。
  // “空闲”因此从最后一次输入后 30 秒多算起；下面第二、三段（拿掉 Clawd、开 reduced motion）照样量，方便以后找别的耗电来源。
  const page = await deck.launch({ args: LAUNCH_ARGS });
  const server = await devServer();
  try {
    const repo = makeRepo(sb, 'idle');
    const { workspaceId } = await setupWorktree(deck, repo, 'feat/idle');
    const terms: { windowId: string; terminalId: string }[] = [];
    for (let i = 0; i < 6; i++) terms.push(await openTerminal(deck, workspaceId, i < 4 ? 'claude' : 'shell'));
    for (const t of terms.slice(0, 4)) await deck.waitForStatus(t.terminalId, 'idle');
    for (const t of terms.slice(4)) await deck.waitForPane(t.terminalId, /e2e\$ *$/m);
    await page.evaluate(
      ({ url, ws, from }) =>
        (window as unknown as { __board: { openWindow(f: string, r: object, o: object): string | null } }).__board.openWindow(
          from,
          { type: 'browser', workspaceId: ws, data: { url, mode: 'frame' } },
          { quiet: true },
        ),
      { url: server.url, ws: workspaceId, from: terms[5]!.windowId },
    );
    await deck.showAll();
    // 聚焦一个终端：右边的 Source Control 面板显示这个工作区
    await deck.focusWindow(terms[0]!.windowId);
    await expect(page.getByText('feat/idle').first()).toBeVisible();
    await deck.screenshot('idle-board');
    // 启动时的事（检测 agent、第一次 git status、字体……）做完，Clawd 也睡下（最后一次输入后 30 秒，CLAWD_NAP_MS）再量
    await page.waitForTimeout(40_000);
    await expect(page.locator('.ad-clawd')).toHaveCount(0);
    const tmuxPid = Number(sb.tmux(['display-message', '-p', '#{pid}']).stdout.trim());

    /** 不动 seconds 秒，量每个进程的平均 CPU（% 一个核）、这段时间里的 IPC 调用和机器负载。 */
    async function measureIdle(seconds: number) {
      await recordInvokes(deck);
      const load = loadSampler(sb.root);
      const a0 = await appProcesses(deck);
      const m0 = treeCpu(tmuxPid);
      const t0 = Date.now();
      await page.waitForTimeout(seconds * 1000);
      const a1 = await appProcesses(deck);
      const m1 = treeCpu(tmuxPid);
      const secs = (Date.now() - t0) / 1000;
      const machine = load.stop();
      const calls = await invokes(deck);
      const pct = (d: number) => Math.round((d / secs) * 1000) / 10;
      const processes = a1.map((p) => {
        const before = a0.find((q) => q.pid === p.pid);
        return { type: p.type, name: p.name, pid: p.pid, cpuPct: pct(p.cpuSec - (before?.cpuSec ?? p.cpuSec)), idleWakeupsPerSec: p.idleWakeups };
      });
      const appTotalPct = Math.round(processes.reduce((s, p) => s + p.cpuPct, 0) * 10) / 10;
      const tmuxTree = [...m1.entries()].map(([pid, v]) => ({ pid, command: v.command.slice(0, 50), cpuPct: pct(v.cpuSec - (m0.get(pid)?.cpuSec ?? v.cpuSec)) }));
      const tmuxTotalPct = Math.round(tmuxTree.reduce((s, p) => s + p.cpuPct, 0) * 10) / 10;
      const ipc: Record<string, number> = {};
      for (const c of calls) ipc[c.call] = (ipc[c.call] ?? 0) + 1;
      return {
        seconds: Math.round(secs),
        appTotalPct,
        processes,
        tmuxTotalPct,
        tmuxProcesses: tmuxTree.length,
        tmuxBusiest: tmuxTree.sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 3),
        ipcDuringIdle: ipc,
        machine,
      };
    }
    /** 页面里一直在跑的 CSS / Web 动画（空闲时它们让界面和 GPU 每帧都要画）。 */
    const runningAnimations = () =>
      page.evaluate(() =>
        document
          .getAnimations()
          .filter((a) => a.playState === 'running')
          .map((a) => {
            const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
            const name = (a as Animation & { animationName?: string }).animationName ?? a.id;
            return `${name} on .${String(t?.getAttribute('class') ?? t?.tagName ?? '?').split(' ')[0]} (${a.effect?.getTiming().iterations === Infinity ? 'infinite' : 'finite'})`;
          }),
      );

    const idle = await measureIdle(60);
    const animations = await runningAnimations();
    // 量的这一分钟里 Clawd 没再冒出来
    await expect(page.locator('.ad-clawd')).toHaveCount(0);
    report(info, 'G4', { ...idle, runningAnimations: animations });
    await deck.screenshot('after-idle');
    // 找原因用（不判）：同样的画面只把左下角的 Clawd 拿掉（display: none，它的动画跟着停），再量 30 秒
    await page.addStyleTag({ content: '.ad-clawd { display: none !important; }' });
    await page.waitForTimeout(2000);
    const noClawd = await measureIdle(30);
    report(info, 'G4-no-clawd', { ...noClawd, runningAnimations: await runningAnimations() });
    // 再开 prefers-reduced-motion（所有 CSS 动画、过渡停掉），再量 30 秒：和上一段差不多就说明别的动画不是原因
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(2000);
    const still = await measureIdle(30);
    report(info, 'G4-reduced-motion', { ...still, runningAnimations: await runningAnimations() });

    // G4 的完成标准“空闲时 CPU 接近 0”：应用所有进程加起来 ≤ 2% 一个核、每个进程 ≤ 1%，tmux 服务那一串 ≤ 1%；空闲时不调 git
    expect.soft(idle.appTotalPct, 'all app processes, % of one core').toBeLessThanOrEqual(2);
    for (const p of idle.processes) expect.soft(p.cpuPct, `${p.type} ${p.name} (pid ${p.pid}), % of one core`).toBeLessThanOrEqual(1);
    expect.soft(idle.tmuxTotalPct, 'tmux server and its children, % of one core').toBeLessThanOrEqual(1);
    expect.soft(Object.keys(idle.ipcDuringIdle).filter((k) => k.startsWith('git.')), 'git calls while idle').toEqual([]);
  } finally {
    server.proc.kill();
  }
});
