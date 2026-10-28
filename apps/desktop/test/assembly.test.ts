// 组装（第 3 波）用到的纯逻辑：数据目录、登录 shell 环境解析、设置文件、外部程序命令、终端转发层、截图模式、角标、菜单。
import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StatusSnapshot, TerminalId } from '@agentdeck/contracts';
import { createAlerts } from '../src/main/alerts.ts';
import { appleScriptString, editorArgs, openFileInEditor, resolveEditor, systemTerminalPlan } from '../src/main/app-service.ts';
import { fallbackEnv, loginShellLaunch, parseEnvOutput, readLoginEnv, withCommonPaths } from '../src/main/login-env.ts';
import { buildMenuTemplate, MENU_ACCELERATORS, RESERVED_ACCELERATORS } from '../src/main/menu.ts';
import { MAX_SOCKET_PATH, resolvePaths } from '../src/main/paths.ts';
import { createScreenshotter } from '../src/main/screenshot.ts';
import { defaultSettings, mergeSettings, openSettingsFile } from '../src/main/settings.ts';
import { createTerminalProxy } from '../src/main/terminal-service.ts';
import type { HostControlMessage } from '../src/shared/host-protocol.ts';

describe('resolvePaths', () => {
  const base = { homeDir: '/Users/me', uid: 501, resourcesPath: null };
  it('dev uses the repo’s .agentdeck-dev and its own tmux socket', () => {
    const p = resolvePaths({ ...base, env: {}, isDev: true, repoRoot: '/r' });
    expect(p.dataDir).toBe('/r/.agentdeck-dev');
    expect(p.tmuxSocketName).toBe('agentdeck-desktop-dev');
    expect(p.runDir).toBe('/r/.agentdeck-dev/run');
    expect(p.worktreeHome).toBe('/r/.agentdeck-dev/home');
    expect(p.tmuxConf).toBe('/r/packages/tmux-host/tmux.conf');
    expect(p.notifyScript).toBe('/r/tools/agentdeck-notify/bin/agentdeck-notify.mjs');
    expect(p.agentExtension).toBe('/r/tools/agentdeck-notify/bin/agentdeck-pi-extension.mjs');
    expect(p.cliScript).toBe('/r/tools/agentdeck-cli/bin/agentdeck.mjs');
  });
  it('packaged uses ~/.agentdeck and the default worktree home', () => {
    const p = resolvePaths({ ...base, env: {}, isDev: false, repoRoot: null, resourcesPath: '/App/Resources' });
    expect(p.dataDir).toBe('/Users/me/.agentdeck');
    expect(p.tmuxSocketName).toBe('agentdeck');
    expect(p.worktreeHome).toBe('/Users/me');
    expect(p.tmuxConf).toBe('/App/Resources/tmux.conf');
    expect(p.agentExtension).toBe('/App/Resources/agentdeck-pi-extension.mjs');
    expect(p.cliScript).toBe('/App/Resources/agentdeck.mjs');
  });
  it('AGENTDECK_DATA_DIR and AGENTDECK_TMUX_SOCKET override', () => {
    const p = resolvePaths({ ...base, env: { AGENTDECK_DATA_DIR: '/d', AGENTDECK_TMUX_SOCKET: 'x' }, isDev: true, repoRoot: '/r' });
    expect(p.dataDir).toBe('/d');
    expect(p.tmuxSocketName).toBe('x');
  });
  it('moves the run dir to /tmp when socket paths would be too long', () => {
    const long = `/Users/me/${'deep/'.repeat(20)}`;
    const p = resolvePaths({ ...base, env: {}, isDev: true, repoRoot: long });
    expect(p.runDir).toMatch(/^\/tmp\/agentdeck-501-[0-9a-f]{10}$/);
    expect(join(p.runDir, `term-${p.tmuxSocketName}.sock`).length).toBeLessThanOrEqual(MAX_SOCKET_PATH);
  });
});

describe('login env', () => {
  it('takes only what follows the marker', () => {
    const out = 'Welcome!\n__AGENTDECK_ENV_BEGIN__\0PATH=/opt/homebrew/bin:/usr/bin\0https_proxy=http://127.0.0.1:7890\0A=b=c\0';
    expect(parseEnvOutput(out)).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', https_proxy: 'http://127.0.0.1:7890', A: 'b=c' });
  });
  it('rejects output without the marker or PATH', () => {
    expect(parseEnvOutput('PATH=/bin\0')).toBeNull();
    expect(parseEnvOutput('__AGENTDECK_ENV_BEGIN__\0A=1\0')).toBeNull();
  });
  const me = { username: 'me', homedir: '/Users/me', shell: '/bin/bash' };
  it('fallback adds the usual PATH entries that exist', () => {
    const exists = (d: string) => ['/opt/homebrew/bin', '/usr/local/bin', '/Users/me/.local/bin', '/Users/me/.bun/bin'].includes(d);
    const env = fallbackEnv({ HOME: '/Users/me', PATH: '/usr/bin:/bin' }, { user: me, exists });
    expect(env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin:/Users/me/.bun/bin');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.SHELL).toBe('/bin/bash');
  });
  it('withCommonPaths keeps the order and does not duplicate (IS-11)', () => {
    const env = withCommonPaths({ HOME: '/Users/me', PATH: '/Users/me/.bun/bin:/usr/bin' }, () => true);
    const path = env.PATH!.split(':');
    expect(path.slice(0, 2)).toEqual(['/Users/me/.bun/bin', '/usr/bin']);
    expect(path.filter((d) => d === '/Users/me/.bun/bin')).toHaveLength(1);
    expect(path).toContain('/opt/homebrew/bin');
    expect(path).toContain('/Users/me/.local/bin');
  });
  it('launched from Finder with almost no environment: SHELL and USER come from the user record (IS-11)', () => {
    const launch = loginShellLaunch({ HOME: '/Users/me' }, me);
    expect(launch.shell).toBe('/bin/bash');
    expect(launch.env).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/me', USER: 'me', LOGNAME: 'me', LANG: 'en_US.UTF-8', SHELL: '/bin/bash' });
    // 环境里有的优先
    expect(loginShellLaunch({ HOME: '/h', SHELL: '/bin/zsh', USER: 'u' }, me)).toMatchObject({ shell: '/bin/zsh', env: { HOME: '/h', USER: 'u' } });
    expect(loginShellLaunch({}, null).shell).toBe('/bin/zsh');
  });
  it('reads a real login shell from a minimal environment (IS-11)', async () => {
    const res = await readLoginEnv({ current: { HOME: process.env['HOME'] }, user: { ...me, homedir: process.env['HOME'] ?? '/', shell: '/bin/sh' } });
    expect(res.warning).toBeNull();
    expect(res.env.PATH).toContain('/usr/bin');
    expect(res.env.HOME).toBe(process.env['HOME']);
  });
});

describe('settings file', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('drops fields of the wrong type', () => {
    const d = defaultSettings(['rm -rf']);
    const s = mergeSettings(d, { closeWindow: 'never', notifications: false, approvals: { destructivePatterns: ['x', 3] } });
    expect(s.closeWindow).toBe('background');
    expect(s.notifications).toBe(false);
    expect(s.approvals.destructivePatterns).toEqual(['x']);
  });
  it('writes the merged settings and reads them back', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentdeck-settings-'));
    const path = join(dir, 'sub', 'settings.json');
    const file = openSettingsFile(path, defaultSettings([]));
    expect(file.update({ editorCommand: 'cursor -g' }).editorCommand).toBe('cursor -g');
    expect(JSON.parse(await readFile(path, 'utf8')).editorCommand).toBe('cursor -g');
    expect(openSettingsFile(path, defaultSettings([])).get().editorCommand).toBe('cursor -g');
  });
  it('picks up hand edits without a restart and keeps them on the next update (IS-47)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentdeck-settings-'));
    const path = join(dir, 'settings.json');
    const file = openSettingsFile(path, defaultSettings([]));
    file.update({ editorCommand: 'cursor -g' });
    const edited = { ...JSON.parse(await readFile(path, 'utf8')), editorCommand: 'zed', terminalApp: 'iTerm' };
    await writeFile(path, JSON.stringify(edited));
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    expect(file.get().editorCommand).toBe('zed');
    file.update({ notifications: false });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved).toMatchObject({ editorCommand: 'zed', terminalApp: 'iTerm', notifications: false });
    // 改坏了：继续用上一次的
    await writeFile(path, '{ broken');
    await utimes(path, new Date(), new Date(Date.now() + 10000));
    expect(file.get().editorCommand).toBe('zed');
  });
});

describe('external programs', () => {
  it('editor gets file:line only when it understands it', () => {
    expect(editorArgs('code -g', '/a/b.ts', 12)).toEqual({ cmd: 'code', args: ['-g', '/a/b.ts:12'] });
    expect(editorArgs('subl', '/a/b.ts', 3)).toEqual({ cmd: 'subl', args: ['/a/b.ts:3'] });
    expect(editorArgs('vim', '/a/b.ts', 3)).toEqual({ cmd: 'vim', args: ['/a/b.ts'] });
    expect(editorArgs('', '/a')).toBeNull();
  });
  it('system terminal plans', () => {
    expect(appleScriptString('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
    expect(systemTerminalPlan('Terminal', "tmux attach -t '=t-1'")).toMatchObject({ kind: 'osascript' });
    expect(systemTerminalPlan('iTerm', 'x')).toMatchObject({ kind: 'osascript' });
    expect(systemTerminalPlan('Ghostty', 'x')).toEqual({ kind: 'command-file' });
  });

  describe('opening settings.json (IS-47)', () => {
    let bin = '';
    afterEach(async () => {
      if (bin) await rm(bin, { recursive: true, force: true });
      bin = '';
    });
    async function fakeEditor(name: string): Promise<string> {
      bin = await mkdtemp(join(tmpdir(), 'ad-editor-'));
      const file = join(bin, name);
      await writeFile(file, '#!/bin/sh\n');
      await chmod(file, 0o755);
      return bin;
    }

    it('opens it with the editor command, never the system default app', async () => {
      const dir = await fakeEditor('code');
      const run = vi.fn(async () => {});
      const reveal = vi.fn();
      const res = await openFileInEditor('/data/settings.json', { editorCommand: 'code -g', env: { PATH: dir }, showItemInFolder: reveal, run });
      expect(res).toEqual({ opened: 'editor' });
      expect(run).toHaveBeenCalledWith(join(dir, 'code'), ['-g', '/data/settings.json'], { PATH: dir }, '/data');
      expect(reveal).not.toHaveBeenCalled();
    });

    it('finds the editor CLI inside the app bundle when it is not on PATH', async () => {
      const vscode = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
      expect(await resolveEditor('code', { PATH: '/nonexistent' }, (p) => p === vscode)).toBe(vscode);
      expect(await resolveEditor('code', { PATH: '/nonexistent', HOME: '/Users/me' }, (p) => p === `/Users/me${vscode}`)).toBe(`/Users/me${vscode}`);
      expect(await resolveEditor('nano-x', { PATH: '/nonexistent' }, () => true)).toBeNull();
      const run = vi.fn(async () => {});
      const res = await openFileInEditor('/data/settings.json', { editorCommand: 'code -g', env: { PATH: '/nonexistent' }, showItemInFolder: vi.fn(), run, exists: (p) => p === vscode });
      expect(res).toEqual({ opened: 'editor' });
      expect(run).toHaveBeenCalledWith(vscode, ['-g', '/data/settings.json'], { PATH: '/nonexistent' }, '/data');
    });

    it('shows it in Finder with a reason when the editor is missing, empty or fails to start', async () => {
      const reveal = vi.fn();
      const missing = await openFileInEditor('/data/settings.json', { editorCommand: 'echo-1792834415023', env: { PATH: '/nonexistent' }, showItemInFolder: reveal, exists: () => false });
      expect(missing).toMatchObject({ opened: 'finder', message: expect.stringContaining('“echo-1792834415023”') });
      expect(reveal).toHaveBeenCalledWith('/data/settings.json');

      const empty = await openFileInEditor('/data/settings.json', { editorCommand: '  ', env: {}, showItemInFolder: reveal, exists: () => false });
      expect(empty).toMatchObject({ opened: 'finder', message: expect.stringContaining('No editor command is set') });

      const dir = await fakeEditor('code');
      const broken = await openFileInEditor('/data/settings.json', {
        editorCommand: 'code -g',
        env: { PATH: dir },
        showItemInFolder: reveal,
        run: async () => {
          throw new Error('spawn EACCES');
        },
      });
      expect(broken.opened).toBe('finder');
      expect(reveal).toHaveBeenCalledTimes(3);
    });
  });
});

describe('terminal proxy', () => {
  function setup() {
    const posted: HostControlMessage[] = [];
    let window: number | undefined = 7;
    const proxy = createTerminalProxy({ channel: { post: (m) => posted.push(m) }, currentWindow: () => window, timeoutMs: 1000 });
    return { proxy, posted, setWindow: (w: number | undefined) => (window = w) };
  }
  it('forwards calls and resolves with the reply; attach carries the window', async () => {
    const { proxy, posted } = setup();
    const attach = proxy.attach('t-1' as TerminalId, { cols: 80, rows: 24 });
    const call = posted[0] as Extract<HostControlMessage, { type: 'call' }>;
    expect(call).toMatchObject({ type: 'call', method: 'attach', windowId: 7 });
    proxy.handle({ type: 'result', callId: call.callId, result: { viewId: 'v1' } });
    await expect(attach).resolves.toEqual({ viewId: 'v1' });
  });
  it('turns error replies into AgentDeckError and write into a fire-and-forget call', async () => {
    const { proxy, posted } = setup();
    const kill = proxy.kill('nope' as TerminalId);
    const call = posted[0] as Extract<HostControlMessage, { type: 'call' }>;
    expect(call.windowId).toBeUndefined();
    proxy.handle({ type: 'error', callId: call.callId, error: { code: 'not-found', message: 'Terminal nope not found' } });
    await expect(kill).rejects.toMatchObject({ code: 'not-found' });
    proxy.write('v1' as never, 'ls\r');
    expect(posted[1]).toMatchObject({ type: 'call', callId: 0, method: 'write' });
  });
  it('fails pending calls when the host exits, and remembers start errors', async () => {
    const { proxy } = setup();
    proxy.handle({ type: 'start-failed', error: { code: 'tmux-unavailable', message: 'tmux 3.5 or later is required (found 3.4).' } });
    expect(proxy.startError?.code).toBe('tmux-unavailable');
    const list = proxy.list();
    proxy.hostExited(1);
    await expect(list).rejects.toMatchObject({ code: 'tmux-unavailable' });
    await expect(proxy.list()).rejects.toMatchObject({ code: 'tmux-unavailable' });
  });
  it('dispatches events', () => {
    const { proxy } = setup();
    const seen = vi.fn();
    proxy.onEvent(seen);
    proxy.handle({ type: 'event', event: { type: 'terminal.input', id: 't-1' as TerminalId, at: 'now' } });
    expect(seen).toHaveBeenCalledWith({ type: 'terminal.input', id: 't-1', at: 'now' });
  });
});

describe('screenshotter', () => {
  afterEach(() => vi.useRealTimers());
  it('waits for the board and every visible terminal, then settles', async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => Buffer.from('png'));
    const done = vi.fn();
    const dir = await mkdtemp(join(tmpdir(), 'agentdeck-shot-'));
    const s = createScreenshotter({ path: join(dir, 'a', 'shot.png'), capture, done, settleMs: 100 });
    s.start();
    s.terminalData('v1');
    s.boardReady({ visibleTerminals: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).not.toHaveBeenCalled();
    s.terminalData('v2');
    await vi.advanceTimersByTimeAsync(150);
    vi.useRealTimers();
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(true));
    expect(await readFile(join(dir, 'a', 'shot.png'), 'utf8')).toBe('png');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('alerts', () => {
  const snap = (status: StatusSnapshot['status'], id = 'r1'): StatusSnapshot => ({
    terminalId: 't-1' as TerminalId,
    status,
    since: 'now',
    exitCode: null,
    pending: status === 'needs-approval' ? { id: id as never, terminalId: 't-1' as TerminalId, workspaceId: null, agent: 'claude', kind: 'approval', summary: 'pnpm test', command: 'pnpm test', destructive: false, at: 'now' } : null,
  });
  it('notifies once in the background and shows the badge only when not focused', () => {
    let focused = false;
    const notify = vi.fn();
    const badge = vi.fn();
    const a = createAlerts({ appFocused: () => focused, notificationsEnabled: () => true, label: () => 'claude', notify, setDockBadge: badge });
    a.onStatus(snap('needs-approval'));
    a.onStatus(snap('needs-approval'));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ title: 'claude needs approval', body: 'pnpm test' });
    expect(badge).toHaveBeenLastCalledWith(1);
    focused = true;
    a.focusChanged();
    expect(badge).toHaveBeenLastCalledWith(0);
    focused = false;
    a.onStatus(snap('idle'));
    a.setBoardBadge(2);
    expect(badge).toHaveBeenLastCalledWith(2);
  });
});

describe('menu', () => {
  type Item = { accelerator?: string; submenu?: Item[]; role?: string };
  const all = (items: Item[]): Item[] => items.flatMap((i) => [i, ...all(i.submenu ?? [])]);
  const template = buildMenuTemplate('AgentDeck', { shortcut: vi.fn(), quit: vi.fn(), dev: { reload: vi.fn(), toggleDevTools: vi.fn() } });
  const items = all(template as Item[]);
  it('never takes ⌘R ⌘[ ⌘] ⌘L and has no close-window role', () => {
    const accels = items.map((i) => i.accelerator).filter(Boolean);
    for (const r of RESERVED_ACCELERATORS) expect(accels).not.toContain(r);
    expect(items.some((i) => i.role === 'windowMenu' || i.role === 'close' || i.role === 'reload' || i.role === 'forceReload')).toBe(false);
  });
  it('registers every board shortcut and an Edit menu', () => {
    const accels = items.map((i) => i.accelerator);
    for (const a of Object.values(MENU_ACCELERATORS)) expect(accels).toContain(a);
    expect(items.some((i) => i.role === 'paste')).toBe(true);
  });
  it('Go menu: next / previous waiting terminal and next / previous window (S3)', () => {
    const go = (template as (Item & { label?: string })[]).find((m) => m.label === 'Go')!;
    const entries = (go.submenu as (Item & { label?: string })[]).filter((i) => i.label).map((i) => [i.label, i.accelerator]);
    expect(entries).toEqual([
      ['Next Waiting Terminal', 'CmdOrCtrl+J'],
      ['Previous Waiting Terminal', 'Shift+CmdOrCtrl+J'],
      ['Next Window', 'Shift+CmdOrCtrl+]'],
      ['Previous Window', 'Shift+CmdOrCtrl+['],
      ['Jump to Agent', undefined],
    ]);
    // CO4：⌥⌘1–9 跳到 Agents 视图的第 n 行
    const jump = (go.submenu as (Item & { label?: string })[]).find((i) => i.label === 'Jump to Agent')!;
    expect((jump.submenu as (Item & { label?: string })[]).map((i) => [i.label, i.accelerator])).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`Row ${n}`, `Alt+CmdOrCtrl+${n}`]),
    );
  });
  it('Settings… ⌘, opens the settings dialog in the board instead of the file', () => {
    const shortcut = vi.fn();
    const menu = all(buildMenuTemplate('AgentDeck', { shortcut, quit: vi.fn(), dev: null }) as Item[]) as (Item & { label?: string; click?: () => void })[];
    const settings = menu.find((i) => i.label === 'Settings…')!;
    expect(settings.accelerator).toBe('CmdOrCtrl+,');
    settings.click!();
    expect(shortcut).toHaveBeenCalledWith('open-settings');
  });
});

describe('limits assembly (PL5)', () => {
  it('reads the test timings from the environment', async () => {
    const { limitTimingFromEnv } = await import('../src/main/limits.ts');
    expect(limitTimingFromEnv({ AGENTDECK_RESUME_STAGGER_MS: '2000', AGENTDECK_LIMIT_GRACE_MS: '5000' })).toEqual({ staggerMs: 2000, graceMs: 5000 });
    expect(limitTimingFromEnv({ AGENTDECK_RESUME_STAGGER_MS: 'soon' })).toEqual({});
    expect(limitTimingFromEnv({})).toEqual({});
  });

  it('keeps the Mac awake while the queue or the limits want it, and lets go when neither does', async () => {
    const { createKeepAwake } = await import('../src/main/limits.ts');
    const start = vi.fn(() => 7);
    const stop = vi.fn();
    const keepAwake = createKeepAwake({ start, stop });
    keepAwake('queue', true);
    keepAwake('limits', true);
    expect(start).toHaveBeenCalledTimes(1);
    keepAwake('queue', false);
    expect(stop).not.toHaveBeenCalled();
    keepAwake('limits', false);
    expect(stop).toHaveBeenCalledWith(7);
    keepAwake('limits', false);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
