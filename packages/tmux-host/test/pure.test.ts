import { describe, expect, it } from 'vitest';
import { classifyInput, cleanTitle, exitCodeOf, paneEnv, parseSessions, parseTmuxVersion, serverEnv, signalNumber } from '../src/index.ts';
import { shQuote, tmuxFormatEscape, versionAtLeast } from '../src/tmux.ts';

describe('classifyInput', () => {
  it('typing counts as user input', () => {
    expect(classifyInput('a')).toEqual({ user: true, mouse: false, keys: true });
    expect(classifyInput('\x1b')).toMatchObject({ user: true, keys: true });
    expect(classifyInput('\x1b[13;2u')).toMatchObject({ user: true, keys: true });
    expect(classifyInput('\x1b[200~line 1\rline 2\x1b[201~')).toMatchObject({ user: true });
  });

  it('terminal replies and focus events are not user input', () => {
    for (const s of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;40R', '\x1bP>|xterm.js\x1b\\', '\x1b]10;rgb:1a1a/1a1a/1a1a\x1b\\', '\x1b]11;rgb:f7f7/f7f7/f5f5\x07', '\x1b[?997;2n', '\x1b[?2004;1$y']) {
      expect(classifyInput(s), JSON.stringify(s)).toEqual({ user: false, mouse: false, keys: false });
    }
    expect(classifyInput('\x1b[?1;2c\x1b]10;rgb:0/0/0\x1b\\')).toMatchObject({ user: false });
  });

  it('wheel and motion are mouse but not input; clicks are input', () => {
    expect(classifyInput('\x1b[<64;10;5M')).toEqual({ user: false, mouse: true, keys: false });
    expect(classifyInput('\x1b[<35;10;5M')).toEqual({ user: false, mouse: true, keys: false });
    expect(classifyInput('\x1b[<0;10;5M\x1b[<0;10;5m')).toEqual({ user: true, mouse: true, keys: false });
  });

  it('PageUp / PageDown stay in copy-mode', () => {
    expect(classifyInput('\x1b[5~')).toMatchObject({ user: true, keys: false });
    expect(classifyInput('\x1b[6~')).toMatchObject({ user: true, keys: false });
  });
});

describe('exit codes', () => {
  it('uses the status, or 128 + signal number', () => {
    expect(exitCodeOf('3', '')).toBe(3);
    expect(exitCodeOf('0', '')).toBe(0);
    expect(exitCodeOf('', 'term')).toBe(143);
    expect(exitCodeOf('', 'kill')).toBe(137);
    expect(exitCodeOf('', 'hup')).toBe(129);
    expect(exitCodeOf('', '')).toBeNull();
    expect(signalNumber('SIGINT')).toBe(2);
    expect(signalNumber('9')).toBe(9);
    expect(signalNumber('nonsense')).toBe(1);
  });
});

describe('parseTmuxVersion', () => {
  it('parses the usual forms', () => {
    expect(parseTmuxVersion('tmux 3.6a\n')).toMatchObject({ major: 3, minor: 6 });
    expect(parseTmuxVersion('tmux 3.5')).toMatchObject({ major: 3, minor: 5 });
    expect(parseTmuxVersion('tmux next-3.7')).toMatchObject({ major: 3, minor: 7 });
    expect(parseTmuxVersion('tmux openbsd-7.6')).toMatchObject({ major: 99 });
    expect(parseTmuxVersion('garbage')).toBeNull();
    expect(versionAtLeast(parseTmuxVersion('tmux 3.4')!, { major: 3, minor: 5 })).toBe(false);
    expect(versionAtLeast(parseTmuxVersion('tmux 3.5a')!, { major: 3, minor: 5 })).toBe(true);
    expect(versionAtLeast(parseTmuxVersion('tmux 4.0')!, { major: 3, minor: 5 })).toBe(true);
  });
});

describe('environments', () => {
  const login = {
    HOME: '/Users/me',
    PATH: '/opt/homebrew/bin:/usr/bin',
    SHELL: '/bin/zsh',
    TERM: 'xterm-256color',
    TERM_PROGRAM: 'iTerm.app',
    CLAUDECODE: '1',
    ELECTRON_RUN_AS_NODE: '1',
    ANTHROPIC_API_KEY: 'k',
    'BASH_FUNC_x%%': '() { :; }',
  };

  it('pane env keeps the login env minus terminal identity and host-injected variables', () => {
    const env = paneEnv(login);
    expect(env).toMatchObject({ HOME: '/Users/me', PATH: '/opt/homebrew/bin:/usr/bin', ANTHROPIC_API_KEY: 'k', LANG: 'en_US.UTF-8' });
    for (const k of ['TERM', 'TERM_PROGRAM', 'CLAUDECODE', 'ELECTRON_RUN_AS_NODE', 'BASH_FUNC_x%%']) expect(env).not.toHaveProperty(k);
  });

  it('server env is minimal', () => {
    expect(serverEnv(login)).toEqual({ HOME: '/Users/me', PATH: '/opt/homebrew/bin:/usr/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8' });
  });
});

describe('parseSessions', () => {
  it('reads list-sessions rows', () => {
    const out = 'a\t/private/tmp\tclaude\t0\t\t\t1792763452\t120\nb\t/tmp\tsh\t1\t\tterm\t1792763400\t80\nc\t/tmp\tsh\t1\t3\t\t0\t80\n';
    expect(parseSessions(out)).toEqual([
      { id: 'a', cwd: '/private/tmp', command: 'claude', dead: false, exitCode: null, activity: 1792763452, width: 120, title: null },
      { id: 'b', cwd: '/tmp', command: 'sh', dead: true, exitCode: 143, activity: 1792763400, width: 80, title: null },
      { id: 'c', cwd: '/tmp', command: 'sh', dead: true, exitCode: 3, activity: 0, width: 80, title: null },
    ]);
  });
  it('reads the program’s terminal title; the host name means none was set', () => {
    const row = (title: string) => `a\t/tmp\tclaude\t0\t\t\t1\t80\tmac.local\t${title}\n`;
    expect(parseSessions(row('✳ Check local git history'))[0]?.title).toBe('Check local git history');
    expect(parseSessions(row('⠐ Fix\tthe build'))[0]?.title).toBe('Fix\tthe build');
    expect(parseSessions(row('hello'))[0]?.title).toBe('hello');
    expect(parseSessions(row('mac.local'))[0]?.title).toBeNull();
    expect(parseSessions(row('mac'))[0]?.title).toBeNull();
    expect(parseSessions(row('✳ '))[0]?.title).toBeNull();
    expect(cleanTitle('π - agenduck', 'mac')).toBe('π - agenduck');
  });
});

describe('quoting', () => {
  it('quotes for sh and escapes tmux formats', () => {
    expect(shQuote('/usr/bin/nc')).toBe('/usr/bin/nc');
    expect(shQuote("/Users/o'neil/a b")).toBe(`'/Users/o'\\''neil/a b'`);
    expect(tmuxFormatEscape('/tmp/50%/#x')).toBe('/tmp/50%%/##x');
  });
});
