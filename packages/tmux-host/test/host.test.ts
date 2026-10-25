// TerminalHost 的集成测试：真的起 tmux（-L 用测试专用的名字，测完 kill-server），不碰用户自己的 tmux 和 AgentDeck 的 agentdeck 实例。
// 没装 tmux 或版本低于 3.5 时整组跳过。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TerminalEvent, TerminalId, TerminalLink, ViewId } from '@agentdeck/contracts';
import { AgentDeckError } from '@agentdeck/contracts';
import { DEFAULT_TMUX_CONF, findExecutable, parseTmuxVersion, startTmuxHost, type LinkWatcher, type TmuxHost } from '../src/index.ts';

const SOCKET = `agentdeck-test-${process.pid}`;
const env: Record<string, string> = {};
for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
env.LANG = 'en_US.UTF-8';
// 宿主环境里的变量（例如在 Claude Code 里跑测试时的 CLAUDECODE）不应进窗格
env.CLAUDECODE = '1';

const tmuxPath = findExecutable('tmux', { PATH: `${env.PATH}:/opt/homebrew/bin:/usr/local/bin` });
const tmuxOk = (() => {
  if (!tmuxPath) return false;
  const v = parseTmuxVersion(execFileSync(tmuxPath, ['-V'], { encoding: 'utf8' }));
  return v !== null && (v.major > 3 || (v.major === 3 && v.minor >= 5));
})();

function tmux(...args: string[]): string {
  return execFileSync(tmuxPath!, ['-L', SOCKET, '-f', DEFAULT_TMUX_CONF, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 测试用的简单链接识别：只认 http://localhost:端口。真正的在 packages/port-watch。 */
function simpleWatcher(): LinkWatcher {
  let carry = '';
  return {
    push(data) {
      const text = carry + data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? '';
      return lines.flatMap((l) => [...l.matchAll(/http:\/\/localhost:\d+\/?/g)].map((m): TerminalLink => ({ kind: 'localhost', url: m[0] })));
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000): Promise<NonNullable<T>> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await sleep(20);
  }
}

describe.skipIf(!tmuxOk)('TmuxHost with real tmux', () => {
  let runDir: string;
  let host: TmuxHost;
  let events: TerminalEvent[];
  let data: Map<ViewId, string>;
  let n = 0;

  const start = async () =>
    startTmuxHost({
      env,
      socketName: SOCKET,
      runDir,
      silenceMs: 400,
      healthIntervalMs: 300,
      linkWatcher: simpleWatcher,
      onEvent: (e) => events.push(e),
      onData: (m) => data.set(m.viewId, (data.get(m.viewId) ?? '') + m.data),
    });
  const id = () => `test-${++n}` as TerminalId;
  const eventsOf = (type: TerminalEvent['type'], tid?: TerminalId) =>
    events.filter((e) => e.type === type && (tid === undefined || ('id' in e && e.id === tid)));
  const cwd = () => tmpdir();

  beforeAll(async () => {
    runDir = mkdtempSync(join(tmpdir(), 'adt-'));
    events = [];
    data = new Map();
    host = await start();
  });

  afterEach(() => {
    events.length = 0;
  });

  afterAll(async () => {
    await host?.killServer();
    await host?.dispose();
    try {
      tmux('kill-server');
    } catch {
      // 已经没了
    }
    rmSync(runDir, { recursive: true, force: true });
    // tmux 3.6a 退出后不删自己的 socket 文件（实测），测试用的名字每次不同，顺手删掉
    rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, SOCKET), { force: true });
  });

  it('reports the tmux version', () => {
    expect(host.tmuxVersion).toMatch(/^tmux /);
  });

  it('creates a session with AGENTDECK_TERM and the login env, without host-only variables', async () => {
    const t = id();
    await host.create({
      id: t,
      cmd: 'sh',
      args: ['-c', 'echo "term=$AGENTDECK_TERM foo=$FOO cc=[$CLAUDECODE] term2=$TERM"; sleep 30'],
      cwd: cwd(),
      env: { FOO: 'bar', AGENTDECK_TERM: 'evil' },
      size: { cols: 100, rows: 20 },
    });
    const lines = await waitFor(async () => {
      const l = await host.lastLines(t, 3);
      return l.some((x) => x.includes('term=')) ? l : null;
    });
    expect(lines.join('\n')).toContain(`term=${t} foo=bar cc=[] term2=tmux-256color`);
    expect(tmux('display-message', '-p', '-t', `=${t}:`, '#{window_width}x#{window_height}').trim()).toBe('100x20');
    const info = (await host.list()).find((i) => i.id === t);
    expect(info).toMatchObject({ alive: true, exitCode: null });
    expect(info?.command).toMatch(/sh|sleep/);
  });

  it('rejects a duplicate id, a missing folder and a missing command', async () => {
    const t = id();
    await host.create({ id: t, cmd: 'sleep', args: ['30'], cwd: cwd() });
    await expect(host.create({ id: t, cmd: 'sleep', args: ['30'], cwd: cwd() })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(host.create({ cmd: 'sleep', args: ['30'], cwd: '/nonexistent/folder' })).rejects.toMatchObject({ code: 'invalid-argument' });
    const err = await host.create({ cmd: 'definitely-not-a-command-xyz', args: [], cwd: cwd() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentDeckError);
    expect(err).toMatchObject({ code: 'command-not-found', message: 'Command not found: definitely-not-a-command-xyz' });
    await expect(host.create({ id: 'bad:id' as TerminalId, cmd: 'sleep', args: ['1'], cwd: cwd() })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('runs a command without arguments directly (not through a shell)', async () => {
    const t = id();
    await host.create({ id: t, cmd: 'cat', args: [], cwd: cwd() });
    await waitFor(async () => (await host.list()).find((i) => i.id === t)?.command === 'cat');
  });

  it('streams output from the very first line: activity, links, silence', async () => {
    const t = id();
    await host.create({ id: t, cmd: 'sh', args: ['-c', 'echo "ready on http://localhost:5173/"; sleep 30'], cwd: cwd() });
    await waitFor(() => eventsOf('terminal.link', t).length > 0);
    expect(eventsOf('terminal.activity', t)).toHaveLength(1);
    expect(eventsOf('terminal.link', t)[0]).toMatchObject({ link: { kind: 'localhost', url: 'http://localhost:5173/' } });
    expect(await host.recentLinks(t)).toEqual([{ kind: 'localhost', url: 'http://localhost:5173/' }]);
    await waitFor(() => eventsOf('terminal.silence', t).length > 0);
    expect(eventsOf('terminal.silence', t)).toHaveLength(1);
    const info = (await host.list()).find((i) => i.id === t);
    expect(info?.lastActivityAt).not.toBeNull();
  });

  it('reports exit codes, including 128 + signal', async () => {
    const a = id();
    await host.create({ id: a, cmd: 'sh', args: ['-c', 'sleep 0.2; exit 3'], cwd: cwd() });
    await waitFor(() => eventsOf('terminal.exit', a).length > 0);
    expect(eventsOf('terminal.exit', a)).toEqual([{ type: 'terminal.exit', id: a, code: 3 }]);
    expect((await host.list()).find((i) => i.id === a)).toMatchObject({ alive: false, exitCode: 3 });

    const b = id();
    await host.create({ id: b, cmd: 'sleep', args: ['30'], cwd: cwd() });
    const pid = tmux('display-message', '-p', '-t', `=${b}:`, '#{pane_pid}').trim();
    process.kill(Number(pid), 'SIGTERM');
    await waitFor(() => eventsOf('terminal.exit', b).length > 0);
    expect(eventsOf('terminal.exit', b)[0]).toMatchObject({ code: 143 });
  });

  it('kill: emits exit 129 once for a live process, nothing for a dead one', async () => {
    const a = id();
    await host.create({ id: a, cmd: 'sleep', args: ['30'], cwd: cwd() });
    await host.kill(a);
    expect(eventsOf('terminal.exit', a)).toEqual([{ type: 'terminal.exit', id: a, code: 129 }]);
    expect((await host.list()).some((i) => i.id === a)).toBe(false);

    const b = id();
    await host.create({ id: b, cmd: 'sh', args: ['-c', 'exit 0'], cwd: cwd() });
    await waitFor(() => eventsOf('terminal.exit', b).length > 0);
    await host.kill(b);
    expect(eventsOf('terminal.exit', b)).toHaveLength(1);
    await expect(host.kill(b)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('attach / write / resize / detach', async () => {
    const t = id();
    await host.create({ id: t, cmd: 'cat', args: [], cwd: cwd(), size: { cols: 80, rows: 24 } });
    const { viewId } = await host.attach(t, { cols: 90, rows: 25 });
    // 首屏之前写的也不会丢（先排队）
    host.write(viewId, 'early\r');
    await waitFor(() => data.get(viewId)?.includes('early'));
    host.write(viewId, '\x1b[I'); // 焦点事件不算输入
    await sleep(50);
    expect(eventsOf('terminal.input', t)).toHaveLength(1);
    host.write(viewId, 'hello world\r');
    await waitFor(() => (data.get(viewId) ?? '').includes('hello world'));
    expect(tmux('display-message', '-p', '-t', `=${t}:`, '#{window_width}x#{window_height}').trim()).toBe('90x25');
    host.resize(viewId, { cols: 70, rows: 20 });
    await waitFor(() => tmux('display-message', '-p', '-t', `=${t}:`, '#{window_width}x#{window_height}').trim() === '70x20');
    expect(tmux('list-clients', '-t', `=${t}`).trim()).not.toBe('');
    await host.detach(viewId);
    await waitFor(() => tmux('list-clients', '-t', `=${t}`).trim() === '');
    // 没人接着时窗口大小保持
    expect(tmux('display-message', '-p', '-t', `=${t}:`, '#{window_width}x#{window_height}').trim()).toBe('70x20');
  });

  it('the redraw after an attach or resize of a quiet terminal is not activity; later output is (IS-72)', async () => {
    const t = id();
    // 像 shell 一样：收到 SIGWINCH 就重画（这里打印 redraw）；USR1 模拟程序真的输出了东西
    const script = 'echo ready; trap "echo redraw" WINCH; trap "echo work" USR1; while :; do sleep 0.05; done';
    await host.create({ id: t, cmd: 'sh', args: ['-c', script], cwd: cwd(), size: { cols: 80, rows: 24 } });
    await waitFor(() => eventsOf('terminal.silence', t).length > 0);
    expect(eventsOf('terminal.activity', t)).toHaveLength(1);
    const redraws = async () => (await host.lastLines(t, 20)).filter((l) => l === 'redraw').length;

    const { viewId } = await host.attach(t, { cols: 90, rows: 25 });
    await waitFor(async () => (await redraws()) >= 1);
    host.resize(viewId, { cols: 70, rows: 20 });
    await waitFor(async () => (await redraws()) >= 2);
    await sleep(100);
    expect(eventsOf('terminal.activity', t)).toHaveLength(1);

    await sleep(1000); // resizeQuietMs 默认 1000
    const pid = tmux('display-message', '-p', '-t', `=${t}:`, '#{pane_pid}').trim();
    process.kill(Number(pid), 'SIGUSR1');
    await waitFor(() => eventsOf('terminal.activity', t).length === 2);
    await host.detach(viewId);
    await host.kill(t);
  });

  it('attach to a missing session throws not-found', async () => {
    await expect(host.attach('nope' as TerminalId, { cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('leaves copy-mode before delivering a key typed while scrolled back', async () => {
    const t = id();
    await host.create({ id: t, cmd: 'sh', args: ['-c', 'seq 1 200; exec cat'], cwd: cwd(), size: { cols: 80, rows: 10 } });
    const { viewId } = await host.attach(t, { cols: 80, rows: 10 });
    await waitFor(() => (data.get(viewId) ?? '').includes('200'));
    host.write(viewId, '\x1b[<64;5;5M'); // 滚轮往上
    await waitFor(() => tmux('display-message', '-p', '-t', `=${t}:`, '#{pane_in_mode}').trim() === '1');
    host.write(viewId, 'z\r');
    await waitFor(() => tmux('display-message', '-p', '-t', `=${t}:`, '#{pane_in_mode}').trim() === '0');
    await waitFor(async () => (await host.lastLines(t, 2)).includes('z'));
    await host.detach(viewId);
  });

  it('sendKeys works without a view and emits terminal.input', async () => {
    const t = id();
    await host.create({ id: t, cmd: 'sh', args: [], cwd: cwd() });
    await sleep(100);
    await host.sendKeys(t, ['echo', 'Space', 'sent-by-keys', 'Enter']);
    await waitFor(async () => (await host.lastLines(t, 5)).some((l) => l === 'sent-by-keys'));
    expect(eventsOf('terminal.input', t).length).toBeGreaterThanOrEqual(1);
  });

  it('lastLines returns the last n non-empty lines of the screen', async () => {
    const t = id();
    await host.create({ id: t, cmd: 'sh', args: ['-c', 'printf "a\\nb\\nc\\nd\\n"; sleep 30'], cwd: cwd(), size: { cols: 80, rows: 20 } });
    await waitFor(async () => (await host.lastLines(t, 3)).join(',') === 'b,c,d');
    expect(await host.lastLines(t, 0)).toEqual([]);
    await expect(host.lastLines('nope' as TerminalId, 3)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('list() reports the title the program set (OSC 2), without the spinner; none for a plain shell (IS-50)', async () => {
    const t = id();
    const plain = id();
    await host.create({ id: t, cmd: 'sh', args: ['-c', "printf '\\033]2;✳ 修好 login bug\\007'; sleep 30"], cwd: cwd(), size: { cols: 80, rows: 20 } });
    await host.create({ id: plain, cmd: 'sh', args: ['-c', 'sleep 30'], cwd: cwd(), size: { cols: 80, rows: 20 } });
    await waitFor(async () => (await host.list()).find((x) => x.id === t)?.title === '修好 login bug').catch(async (e: unknown) => {
      throw new Error(`title was ${JSON.stringify((await host.list()).find((x) => x.id === t)?.title)}: ${String(e)}`);
    });
    expect((await host.list()).find((x) => x.id === plain)?.title).toBeNull();
  });

  it('attachCommand points at the same server and session', async () => {
    const cmd = await host.attachCommand('abc' as TerminalId);
    expect(cmd).toContain(`-L ${SOCKET}`);
    expect(cmd).toContain('-u attach-session -t =abc');
    expect(cmd).not.toContain('-T');
  });

  it('a new host adopts running sessions (reopening the app) and keeps streaming', async () => {
    const t = id();
    await host.create({ id: t, cmd: 'sh', args: ['-c', 'echo "first http://localhost:3000/"; exec cat'], cwd: cwd() });
    await waitFor(() => eventsOf('terminal.link', t).length > 0);
    await host.dispose();
    events.length = 0;
    host = await start();
    expect((await host.list()).find((i) => i.id === t)).toMatchObject({ alive: true });
    // 接回前的链接从 tmux 历史里补回来
    expect(await host.recentLinks(t)).toEqual([{ kind: 'localhost', url: 'http://localhost:3000/' }]);
    await host.sendKeys(t, ['again http://localhost:4000/', 'Enter']);
    await waitFor(() => eventsOf('terminal.link', t).length > 0);
    expect(eventsOf('terminal.activity', t).length).toBeGreaterThanOrEqual(1);
    expect((await host.recentLinks(t)).map((l) => (l.kind === 'localhost' ? l.url : ''))).toEqual(['http://localhost:4000/', 'http://localhost:3000/']);
  });

  it('emits terminal.host-lost when the tmux server goes away', async () => {
    const t = id();
    await host.create({ id: t, cmd: 'sleep', args: ['30'], cwd: cwd() });
    await sleep(400);
    tmux('kill-server');
    await waitFor(() => events.some((e) => e.type === 'terminal.host-lost'), 3000);
    expect(await host.list()).toEqual([]);
  });
});
