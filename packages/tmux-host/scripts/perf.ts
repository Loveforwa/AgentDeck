// T2 的完成标准“6 个真实 agent 同时开，打字无可感知延迟”和 attach 速度。
//
//   node packages/tmux-host/scripts/perf.ts            # 6 个 cat
//   node packages/tmux-host/scripts/perf.ts agents     # 3 个 claude + 3 个 codex（只在输入框里打字，不提交，不调用模型）
//
// 量的是 tmux-host 这一层：write() 到这个 view 收到下一段输出（回显 / agent 重画输入框）的时间，
// 不含 Electron 的 IPC 和 xterm 渲染（那两段要在真窗口里看，见 AGENTS.md「需要人工确认」）。
// 同时开一个不接显示、一直在刷输出的窗格，模拟 pnpm dev 之类的后台输出（走 pipe-pane → activity / 链接）。
// 用 tmux -L agentdeck-perf，结束时 kill-server。

import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TerminalId, ViewId } from '@agentdeck/contracts';
import { startTmuxHost } from '../src/index.ts';

const mode = process.argv[2] === 'agents' ? 'agents' : 'cat';
const N = 6;
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 60);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loginEnv(): Promise<Record<string, string>> {
  const shell = process.env.SHELL ?? '/bin/zsh';
  const base: Record<string, string> = {};
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'PATH']) if (process.env[k]) base[k] = process.env[k]!;
  return new Promise((ok) =>
    execFile(shell, ['-ilc', 'env -0'], { env: base, timeout: 5000, maxBuffer: 4 << 20 }, (_e, out) => {
      const env: Record<string, string> = {};
      for (const kv of (out ?? '').split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      ok(Object.keys(env).length > 0 ? env : base);
    }),
  );
}

function stats(xs: number[]) {
  const a = [...xs].sort((p, q) => p - q);
  const q = (f: number) => a[Math.min(a.length - 1, Math.floor(f * a.length))] ?? NaN;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: a.length, median: r(q(0.5)), p90: r(q(0.9)), p99: r(q(0.99)), max: r(a[a.length - 1] ?? NaN) };
}

const listeners = new Map<ViewId, (d: string) => void>();
let events = 0;
const env = await loginEnv();
const host = await startTmuxHost({
  env,
  socketName: 'agentdeck-perf',
  onEvent: () => events++,
  onData: (m) => listeners.get(m.viewId)?.(m.data),
});
const cwd = resolve(import.meta.dirname, '../../..');
let codexHome: string | null = null;

try {
  // 后台一直出输出的窗格（不接显示）
  await host.create({ id: 'perf-noise' as TerminalId, cmd: 'sh', args: ['-c', 'while true; do seq 1 200; echo http://localhost:5173/; sleep 0.05; done'], cwd });

  const ids: TerminalId[] = [];
  const specs: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  if (mode === 'cat') {
    for (let i = 0; i < N; i++) specs.push({ cmd: 'cat', args: [] });
  } else {
    codexHome = realpathSync(mkdtempSync(join(tmpdir(), 'adp-codex-')));
    const real = join(homedir(), '.codex');
    for (const f of ['auth.json', 'config.toml']) if (existsSync(join(real, f))) cpSync(join(real, f), join(codexHome, f));
    const cfg = join(codexHome, 'config.toml');
    writeFileSync(cfg, `${existsSync(cfg) ? readFileSync(cfg, 'utf8') : ''}\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
    for (let i = 0; i < 3; i++) specs.push({ cmd: 'claude', args: ['--permission-mode', 'plan'], env: { CLAUDE_CODE_TMUX_TRUECOLOR: '1' } });
    for (let i = 0; i < 3; i++) specs.push({ cmd: 'codex', args: ['-s', 'read-only'], env: { CODEX_HOME: codexHome } });
  }
  for (const [i, s] of specs.entries()) {
    const id = `perf-${i}` as TerminalId;
    await host.create({ id, cmd: s.cmd, args: s.args, cwd, env: s.env ?? {}, size: { cols: 100, rows: 30 } });
    ids.push(id);
  }
  if (mode === 'agents') {
    // 等 agent 都画出输入框
    const t0 = Date.now();
    for (const id of ids) {
      while (Date.now() - t0 < 60_000) {
        const s = (await host.lastLines(id, 40)).join('\n');
        if (/❯|›|Ask Codex|for shortcuts/.test(s)) break;
        await sleep(300);
      }
    }
    await sleep(2000);
  }

  // attach 速度：attach() 调用到收到第一段输出（tmux 重画的首屏）
  const attachMs: number[] = [];
  const views: ViewId[] = [];
  for (let round = 0; round < 5; round++) {
    for (const v of views.splice(0)) await host.detach(v);
    await sleep(100);
    for (const id of ids) {
      const t0 = performance.now();
      let first = true;
      const { viewId } = await host.attach(id, { cols: 100, rows: 30 });
      await new Promise<void>((ok) => {
        listeners.set(viewId, () => {
          if (first) {
            first = false;
            attachMs.push(performance.now() - t0);
            ok();
          }
        });
      });
      views.push(viewId);
    }
  }
  await sleep(500);

  // 6 个终端同时打字：每轮给每个 view 各写一个字母，量到这个 view 下一段输出的时间
  const typeMs: number[] = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let r = 0; r < ROUNDS; r++) {
    await Promise.all(
      views.map(
        (v, i) =>
          new Promise<void>((ok) => {
            const t0 = performance.now();
            const timer = setTimeout(() => ok(), 2000);
            listeners.set(v, () => {
              listeners.set(v, () => {});
              clearTimeout(timer);
              typeMs.push(performance.now() - t0);
              ok();
            });
            host.write(v, letters[(r + i) % letters.length]!);
          }),
      ),
    );
    await sleep(40); // 约 25 字/秒/终端，比真人快
  }
  // 清掉输入框里打的字（agent 里 ⌃U / ⌃C 清空，cat 里回车）
  for (const v of views) host.write(v, mode === 'cat' ? '\r' : '\x15');

  const rss = (pid: string) => Number(execFileSync('ps', ['-o', 'rss=', '-p', pid], { encoding: 'utf8' }).trim()) / 1024;
  const serverPid = execFileSync('tmux', ['-L', 'agentdeck-perf', 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }).trim();
  console.log(
    JSON.stringify(
      {
        mode,
        terminals: ids.length,
        backgroundNoise: 'seq 1 200 every 50ms (not attached)',
        attachToFirstOutputMs: stats(attachMs),
        keystrokeToOutputMs: stats(typeMs),
        eventsWhileRunning: events,
        tmuxServerRssMB: Math.round(rss(serverPid)),
        hostProcessRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        tmux: host.tmuxVersion,
      },
      null,
      2,
    ),
  );
} finally {
  await host.killServer();
  await host.dispose();
  if (codexHome) {
    for (let i = 0; i < 10; i++) {
      try {
        execFileSync('pkill', ['-9', '-f', codexHome]);
      } catch {
        // 没有残留
      }
      await sleep(300);
      try {
        rmSync(codexHome, { recursive: true, force: true });
        break;
      } catch {
        // 再试
      }
    }
  }
}
