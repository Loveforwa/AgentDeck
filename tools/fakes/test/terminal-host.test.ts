import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDeckError, TERMINAL_ID_ENV } from '@agentdeck/contracts';
import type { TerminalDataMessage, TerminalId } from '@agentdeck/contracts';
import { FakeEventBus } from '../src/bus.ts';
import { parseRecording, recordings, textRecording } from '../src/recording.ts';
import { FakeTerminalHost, findLinks, keysToData } from '../src/terminal-host.ts';

const req = { cmd: '/bin/zsh', args: ['-l'], cwd: '/Users/you/code/app' };

function setup(opts: ConstructorParameters<typeof FakeTerminalHost>[0] = {}) {
  const bus = new FakeEventBus();
  const host = new FakeTerminalHost({ bus, ...opts });
  const data: TerminalDataMessage[] = [];
  bus.onTerminalData((m) => data.push(m));
  return { bus, host, data };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FakeTerminalHost basics', () => {
  it('creates, lists and kills terminals', async () => {
    const { host, bus } = setup();
    const { id } = await host.create({ ...req, env: { FOO: '1', [TERMINAL_ID_ENV]: 'nope' } });
    expect(host.get(id).env).toEqual({ FOO: '1', [TERMINAL_ID_ENV]: id });
    expect(await host.list()).toEqual([
      { id, cwd: req.cwd, command: 'zsh', alive: true, exitCode: null, lastActivityAt: null, title: null, foregroundCommand: null },
    ]);
    host.setTitle(id, 'Fix the login bug');
    expect((await host.list())[0]?.title).toBe('Fix the login bug');
    await host.kill(id);
    expect(await host.list()).toEqual([]);
    expect(bus.eventsOf('terminal.exit')).toEqual([{ type: 'terminal.exit', id, code: 129 }]);
  });

  it('uses the id the caller passes (CreateTerminalRequest.id), and refuses one that exists (CR15 per-terminal keys)', async () => {
    const { host } = setup();
    const id = 't-0123456789ab' as TerminalId;
    expect(await host.create({ ...req, id })).toEqual({ id });
    expect(host.get(id).env[TERMINAL_ID_ENV]).toBe(id);
    await expect(host.create({ ...req, id })).rejects.toMatchObject({ code: 'invalid-argument' });
    // 不给 id 时照样自己生成
    const { id: other } = await host.create(req);
    expect(other).not.toBe(id);
  });

  it('throws not-found for unknown terminals', async () => {
    const { host } = setup();
    const missing = 'nope' as TerminalId;
    await expect(host.lastLines(missing, 3)).rejects.toBeInstanceOf(AgentDeckError);
    await expect(host.sendKeys(missing, ['Enter'])).rejects.toMatchObject({ code: 'not-found' });
    await expect(host.attach(missing, { cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('echoes writes to attached views and records input', async () => {
    const { host, data } = setup();
    const { id } = await host.create(req);
    const { viewId } = await host.attach(id, { cols: 100, rows: 30 });
    await vi.advanceTimersByTimeAsync(0);
    host.write(viewId, 'ls\r');
    expect(data).toEqual([{ viewId, data: 'ls\r\n' }]);
    expect(host.get(id).inputs).toEqual(['ls\r']);
    host.resize(viewId, { cols: 120, rows: 40 });
    expect(host.get(id).size).toEqual({ cols: 120, rows: 40 });
    await host.detach(viewId);
    host.write(viewId, 'ignored');
    expect(host.get(id).inputs).toEqual(['ls\r']);
  });

  it('sends existing output to a newly attached view once', async () => {
    const { host, data } = setup();
    const id = host.createWith(req, { history: 'hello\r\n' });
    const { viewId } = await host.attach(id, { cols: 80, rows: 24 });
    host.feed(id, 'more\r\n'); // 在补发之前到的输出不能重复
    await vi.advanceTimersByTimeAsync(0);
    host.feed(id, 'last\r\n');
    expect(data.map((m) => m.data).join('')).toBe('hello\r\nmore\r\nlast\r\n');
    expect(data.every((m) => m.viewId === viewId)).toBe(true);
  });

  it('lastLines returns plain text without escapes or overwritten spinner text', async () => {
    const { host } = setup();
    const id = host.createWith(req);
    host.feed(id, '\u001b[1mbold\u001b[0m line\r\nThinking…\r\u001b[2KDone\r\nthird\r\n\r\n');
    expect(await host.lastLines(id, 2)).toEqual(['Done', 'third']);
    expect(await host.lastLines(id, 10)).toEqual(['bold line', 'Done', 'third']);
    expect(await host.lastLines(id, 0)).toEqual([]);
  });

  it('sendKeys translates tmux key names', async () => {
    const { host } = setup({ echo: false });
    const id = host.createWith(req);
    await host.sendKeys(id, ['y', 'Enter']);
    expect(host.get(id).keys).toEqual([['y', 'Enter']]);
    expect(keysToData(['C-c', 'Escape', 'Up', 'abc'])).toBe('\x03\x1b\x1b[Aabc');
  });

  it('attachCommand points at the agentdeck tmux socket', async () => {
    const { host } = setup();
    const id = host.createWith(req, { id: 'my-term' as TerminalId });
    expect(await host.attachCommand(id)).toBe('tmux -L agentdeck attach-session -t my-term');
  });
});

describe('FakeTerminalHost events', () => {
  it('emits activity once per burst and silence after the quiet period', async () => {
    const { host, bus } = setup({ silenceMs: 3000 });
    const id = host.createWith(req);
    host.feed(id, 'a');
    host.feed(id, 'b');
    expect(bus.eventsOf('terminal.activity')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(bus.eventsOf('terminal.silence')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(bus.eventsOf('terminal.silence')).toHaveLength(1);
    host.feed(id, 'c');
    expect(bus.eventsOf('terminal.activity')).toHaveLength(2);
    expect((await host.list())[0]?.lastActivityAt).not.toBeNull();
  });

  it('emits each link once', () => {
    const { host, bus } = setup();
    const id = host.createWith(req);
    host.feed(id, '  Local: \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\r\n');
    host.feed(id, 'again http://localhost:5173/\r\n');
    host.feed(id, 'error in src/app.ts:12:5\r\n');
    expect(bus.eventsOf('terminal.link').map((e) => e.link)).toEqual([
      { kind: 'localhost', url: 'http://localhost:5173/' },
      { kind: 'file', path: 'src/app.ts', line: 12, column: 5 },
    ]);
  });

  it('exit marks the terminal dead and emits terminal.exit', async () => {
    const { host, bus } = setup();
    const id = host.createWith(req);
    host.exit(id, 2);
    expect(await host.list()).toMatchObject([{ id, alive: false, exitCode: 2 }]);
    expect(bus.eventsOf('terminal.exit')).toEqual([{ type: 'terminal.exit', id, code: 2 }]);
    await host.kill(id);
    expect(bus.eventsOf('terminal.exit')).toHaveLength(1);
  });

  it('hostLost clears everything', async () => {
    const { host, bus } = setup();
    host.createWith(req);
    host.hostLost();
    expect(await host.list()).toEqual([]);
    expect(bus.eventsOf('terminal.host-lost')).toHaveLength(1);
  });
});

describe('FakeTerminalHost replay', () => {
  it('starts playback on first attach and follows the delays', async () => {
    const { host, data } = setup();
    const rec = parseRecording([
      { delayMs: 100, data: 'one\r\n' },
      { delayMs: 200, data: 'two\r\n' },
    ]);
    // play() 不等 attach，直接放
    const { id } = await host.create(req);
    host.play(id, rec);
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.get(id).output).toBe('one\r\ntwo\r\n');

    const id2 = host.createWith(req, { recording: rec });
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.get(id2).output).toBe('');
    const { viewId } = await host.attach(id2, { cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(100);
    expect(data).toEqual([{ viewId, data: 'one\r\n' }]);
    await vi.advanceTimersByTimeAsync(199);
    expect(data).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(data.map((m) => m.data)).toEqual(['one\r\n', 'two\r\n']);
    expect(host.get(id2).playbackDone).toBe(true);
  });

  it('keeps playing after detach, like a real tmux session', async () => {
    const { host } = setup();
    const id = host.createWith(req, { recording: textRecording(['a', 'b', 'c'], 100) });
    const { viewId } = await host.attach(id, { cols: 80, rows: 24 });
    await host.detach(viewId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.get(id).output).toBe('abc');
  });

  it('can start on create', async () => {
    const { host } = setup({ playOn: 'create' });
    const id = host.createWith(req, { recording: textRecording(['x']) });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.get(id).output).toBe('x');
  });

  it('pauses on waitForInput until input arrives, then exits', async () => {
    const { host, bus } = setup({ echo: false });
    const rec = parseRecording({
      name: 'ask',
      events: [
        { delayMs: 0, data: 'Allow? (y/n) ' },
        { delayMs: 0, waitForInput: true },
        { delayMs: 50, data: 'ok\r\n' },
        { delayMs: 10, exit: 0 },
      ],
    });
    const id = host.createWith(req, { recording: rec, playOn: 'create' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.get(id).waitingForInput).toBe(true);
    expect(host.get(id).output).toBe('Allow? (y/n) ');
    await host.sendKeys(id, ['y']);
    await vi.advanceTimersByTimeAsync(60);
    expect(host.get(id).output).toBe('Allow? (y/n) ok\r\n');
    expect(host.get(id).alive).toBe(false);
    expect(bus.eventsOf('terminal.exit')).toEqual([{ type: 'terminal.exit', id, code: 0 }]);
  });

  it('uses recordingFor to pick a recording for create()', async () => {
    const { host, bus } = setup({
      recordingFor: (r) => (r.args.join(' ').includes('pnpm dev') ? recordings.pnpmDev : null),
    });
    const { id } = await host.create({ ...req, args: ['-lc', 'pnpm dev'] });
    await host.attach(id, { cols: 100, rows: 24 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(bus.eventsOf('terminal.link').map((e) => e.link)).toContainEqual({
      kind: 'localhost',
      url: 'http://localhost:5173/',
    });
    expect(await host.lastLines(id, 3)).toEqual([
      '  ➜  Local:   http://localhost:5173/',
      '  ➜  Network: use --host to expose',
      '  ➜  press h + enter to show help',
    ]);
  });
});

describe('sample recordings', () => {
  it('claude chat plays to the input box and mentions links', async () => {
    const { host, bus } = setup();
    const id = host.createWith(req, { recording: recordings.claudeChat });
    await host.attach(id, { cols: 100, rows: 30 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(host.get(id).playbackDone).toBe(true);
    const text = (await host.lastLines(id, 50)).join('\n');
    expect(text).toContain('Welcome to Claude Code!');
    expect(text).not.toContain('Thinking');
    expect(bus.eventsOf('terminal.link').map((e) => e.link)).toEqual(
      expect.arrayContaining([
        { kind: 'file', path: 'src/Login.tsx', line: 12 },
        { kind: 'localhost', url: 'http://localhost:5173/login' },
      ]),
    );
  });

  it('approval prompt waits for y', async () => {
    const { host } = setup();
    const id = host.createWith(req, { recording: recordings.approvalPrompt });
    await host.attach(id, { cols: 100, rows: 24 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.get(id).waitingForInput).toBe(true);
    expect((await host.lastLines(id, 1))[0]).toContain('(y/n)');
    await host.sendKeys(id, ['y']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await host.lastLines(id, 3)).join('\n')).toContain('All 12 tests pass');
  });
});

describe('findLinks', () => {
  it('ignores things that only look like links', () => {
    expect(findLinks('v5.4.10 at 3:41:07 PM on 0.0.0.0:3000 and https://example.com:443/x')).toEqual([]);
    expect(findLinks('see /Users/me/a.ts:3 and http://127.0.0.1:8080.')).toEqual([
      { kind: 'localhost', url: 'http://127.0.0.1:8080' },
      { kind: 'file', path: '/Users/me/a.ts', line: 3 },
    ]);
  });
});
