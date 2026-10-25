import { describe, expect, it } from 'vitest';
import {
  classifyInput,
  cleanTitle,
  displayCommandLine,
  exitCodeOf,
  foregroundCommands,
  paneEnv,
  parsePsColumns,
  parseSessions,
  parseTmuxVersion,
  sanitizePrefill,
  serverEnv,
  signalNumber,
} from '../src/index.ts';
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
      { id: 'a', cwd: '/private/tmp', command: 'claude', dead: false, exitCode: null, activity: 1792763452, width: 120, pid: 0, title: null },
      { id: 'b', cwd: '/tmp', command: 'sh', dead: true, exitCode: 143, activity: 1792763400, width: 80, pid: 0, title: null },
      { id: 'c', cwd: '/tmp', command: 'sh', dead: true, exitCode: 3, activity: 0, width: 80, pid: 0, title: null },
    ]);
  });
  it('reads the program’s terminal title; the host name means none was set', () => {
    const row = (title: string) => `a\t/tmp\tclaude\t0\t\t\t1\t80\t4242\tmac.local\t${title}\n`;
    expect(parseSessions(row('x'))[0]?.pid).toBe(4242);
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

describe('X6: foreground command and prefill', () => {
  it('parses ps columns', () => {
    expect(parsePsColumns('  101   101\n 202  303\n\n')).toEqual(new Map([[101, '101'], [202, '303']]));
    expect(parsePsColumns(' 7 node /opt/homebrew/bin/pnpm dev --port 3000\n').get(7)).toBe('node /opt/homebrew/bin/pnpm dev --port 3000');
  });

  it('turns an interpreter running a script on PATH back into the command name', () => {
    const find = (n: string) => (n === 'pnpm' ? '/opt/homebrew/bin/pnpm' : null);
    expect(displayCommandLine('node /opt/homebrew/bin/pnpm dev', {}, find)).toBe('pnpm dev');
    expect(displayCommandLine('/usr/local/bin/python3.12 /opt/homebrew/bin/pnpm  run   build', {}, find)).toBe('pnpm run build');
    // 不在 PATH 上的脚本、解释器的参数、普通命令都原样
    expect(displayCommandLine('node /Users/me/app/server.js', {}, find)).toBe('node /Users/me/app/server.js');
    expect(displayCommandLine('node --inspect /opt/homebrew/bin/pnpm dev', {}, find)).toBe('node --inspect /opt/homebrew/bin/pnpm dev');
    expect(displayCommandLine('sleep 30', {}, find)).toBe('sleep 30');
    // 同名但不是同一个文件：不换
    expect(displayCommandLine('node /tmp/other/pnpm dev', {}, find)).toBe('node /tmp/other/pnpm dev');
  });

  it('reports a command only when the foreground process group is not the pane’s own process', async () => {
    const calls: string[][] = [];
    const ps = async (args: string[]) => {
      calls.push(args);
      if (args.includes('pid=,tpgid=')) return ' 100 100\n 200 250\n 300 -1\n';
      return ' 250 sleep 30\n';
    };
    const fg = await foregroundCommands([100, 200, 300, 0], {}, ps);
    expect(fg).toEqual(new Map([[200, 'sleep 30']]));
    expect(calls).toEqual([
      ['-ww', '-o', 'pid=,tpgid=', '-p', '100,200,300'],
      ['-ww', '-o', 'pid=,args=', '-p', '250'],
    ]);
    // 都在提示符下：只问一次
    calls.length = 0;
    expect((await foregroundCommands([100], {}, ps)).size).toBe(0);
    expect(calls).toHaveLength(1);
    // ps 失败：当作没有
    expect((await foregroundCommands([1], {}, async () => Promise.reject(new Error('no ps')))).size).toBe(0);
  });

  it('prefill never contains control characters (a newline would run the command)', () => {
    expect(sanitizePrefill('pnpm dev')).toBe('pnpm dev');
    expect(sanitizePrefill('pnpm dev\n')).toBe('pnpm dev');
    expect(sanitizePrefill('a\tb\r\nc\u001b[A')).toBe('a b c [A');
    expect(sanitizePrefill('  \n ')).toBeNull();
    expect(sanitizePrefill(undefined)).toBeNull();
  });
});
