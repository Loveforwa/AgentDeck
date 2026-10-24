import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import type { TerminalLink } from '@agentdeck/contracts';
import { isPathInside, normalizePath, outsideWorkspaceTag, platformCompareOptions } from '../src/cwd.ts';
import { decideKey, quotePaths, SHIFT_ENTER } from '../src/keys.ts';
import { findLinks } from '../src/links.ts';
import { installQueryAnswers } from '../src/queries.ts';
import { badgeFor, formatSince } from '../src/status.ts';
import { parseHex, xtermRgb } from '../src/theme.ts';
import { commandName } from '../src/title.ts';

// packages/port-watch/test/link-cases.json 的副本（界面包不能 import 服务包）；port-watch 的测试检查两份一样
import linkCases from './link-cases.json';

const { cases } = linkCases as { cases: { line: string; links: TerminalLink[] }[] };

describe('links (same rules as port-watch)', () => {
  for (const c of cases) {
    it(JSON.stringify(c.line), () => expect(findLinks(c.line)).toEqual(c.links));
  }
});

describe('decideKey', () => {
  const k = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}, type = 'keydown') => ({
    type,
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  it('sends everything without ⌘ to the terminal', () => {
    for (const key of ['Escape', 'Tab', 'ArrowUp', ' ', 'a', 'Enter']) expect(decideKey(k(key), true)).toEqual({ kind: 'terminal' });
    expect(decideKey(k('c', { ctrlKey: true }), true)).toEqual({ kind: 'terminal' });
    expect(decideKey(k('Enter', { altKey: true }), true)).toEqual({ kind: 'terminal' });
  });
  it('maps Shift+Enter to CSI u and swallows its keypress', () => {
    expect(decideKey(k('Enter', { shiftKey: true }), true)).toEqual({ kind: 'send', data: SHIFT_ENTER });
    expect(decideKey(k('Enter', { shiftKey: true }, 'keypress'), true)).toEqual({ kind: 'native' });
  });
  it('leaves ⌘C / ⌘V to the browser and other ⌘ keys to the board', () => {
    expect(decideKey(k('c', { metaKey: true }), true)).toEqual({ kind: 'native' });
    expect(decideKey(k('v', { metaKey: true }), true)).toEqual({ kind: 'native' });
    expect(decideKey(k('k', { metaKey: true }), true)).toEqual({ kind: 'board' });
    expect(decideKey(k('Enter', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'board' });
  });
});

describe('quotePaths', () => {
  it('single-quotes each path', () => {
    expect(quotePaths(['/a b/c.png', "/it's.txt"])).toBe(`'/a b/c.png' '/it'\\''s.txt' `);
    expect(quotePaths([])).toBe('');
  });
});

describe('status badge', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  it('formats time', () => {
    expect(formatSince(ago(20), now)).toBe('now');
    expect(formatSince(ago(4 * 60 + 5), now)).toBe('4m');
    expect(formatSince(ago(2 * 3600 + 1), now)).toBe('2h');
    expect(formatSince('2026-10-21T08:00:00Z', now)).toBe('Oct 21');
  });
  it('maps statuses', () => {
    const b = (status: Parameters<typeof badgeFor>[0]['status'], exitCode: number | null = null) => badgeFor({ status, since: ago(300), exitCode }, now);
    expect(b('starting')).toEqual({ text: 'Starting', tone: 'muted', dot: 'hollow' });
    expect(b('running')).toEqual({ text: 'Running · 5m', tone: 'running', dot: 'filled' });
    expect(b('needs-approval')).toEqual({ text: 'Waiting · 5m', tone: 'attention', dot: 'filled', detail: 'Needs approval' });
    expect(b('needs-reply')).toEqual({ text: 'Waiting · 5m', tone: 'attention', dot: 'filled', detail: 'Needs reply' });
    expect(b('idle')).toEqual({ text: 'Idle · 5m', tone: 'muted', dot: 'hollow' });
    expect(b('exited', 0)).toEqual({ text: 'Exited', tone: 'muted', dot: 'none' });
    expect(b('error', 1)).toEqual({ text: 'Error · exit 1', tone: 'error', dot: 'filled' });
  });
});

describe('theme helpers', () => {
  // 测的就是把 tokens 里的十六进制颜色换成 xterm 的格式，只能写颜色值
  /* eslint-disable no-restricted-syntax -- 测试颜色转换本身 */
  it('converts token colors for xterm replies', () => {
    expect(parseHex('#1A1A1A')).toEqual([26, 26, 26]); // raw-color-ok 测颜色转换本身
    expect(parseHex('#fff')).toEqual([255, 255, 255]); // raw-color-ok 测颜色转换本身
    expect(parseHex('rgba(0,0,0,0.1)')).toBeNull(); // raw-color-ok 测颜色转换本身
    expect(xtermRgb('#F7F7F5', [0, 0, 0])).toBe('rgb:f7f7/f7f7/f5f5'); // raw-color-ok 测颜色转换本身
    expect(xtermRgb('', [26, 26, 26])).toBe('rgb:1a1a/1a1a/1a1a'); // raw-color-ok 测颜色转换本身
  });
  /* eslint-enable no-restricted-syntax */
});

describe('commandName', () => {
  it('uses the agent name, or the command for shells', () => {
    expect(commandName({ agent: 'claude', cmd: 'claude', startCommand: null })).toBe('claude');
    expect(commandName({ agent: 'shell', cmd: '/bin/zsh', startCommand: 'pnpm dev' })).toBe('zsh');
    expect(commandName({ agent: 'custom', cmd: 'pnpm', startCommand: 'pnpm dev' })).toBe('pnpm');
  });
});

describe('query answers on a real xterm parser', () => {
  it('answers XTVERSION, OSC 10/11 and the theme query', async () => {
    const term = new Terminal({ allowProposedApi: true });
    const out: string[] = [];
    installQueryAnswers(term.parser, (d) => out.push(d), () => ({ fg: 'rgb:1a1a/1a1a/1a1a', bg: 'rgb:ffff/ffff/ffff', dark: false }));
    await new Promise<void>((r) => term.write('\x1b[>q\x1b]10;?\x1b\\\x1b]11;?\x07\x1b[?996n\x1b]10;rgb:0/0/0\x1b\\', r));
    expect(out).toEqual(['\x1bP>|xterm.js\x1b\\', '\x1b]10;rgb:1a1a/1a1a/1a1a\x1b\\', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\', '\x1b[?997;2n']);
  });

  it('reports a dark/light switch only while tmux has asked for it with ?2031 (IS-42)', async () => {
    const term = new Terminal({ allowProposedApi: true });
    const out: string[] = [];
    let dark = false;
    const q = installQueryAnswers(term.parser, (d) => out.push(d), () => ({ fg: '', bg: '', dark }));
    const write = (d: string) => new Promise<void>((r) => term.write(d, r));
    dark = true;
    q.themeChanged();
    expect(out).toEqual([]);
    // tmux 3.6a attach 时发的就是单独一条 ?2031h；和别的模式写在一起也要认
    await write('\x1b[?1004;2031h');
    q.themeChanged();
    dark = false;
    q.themeChanged();
    expect(out).toEqual(['\x1b[?997;1n', '\x1b[?997;2n']);
    // 其他模式照常生效
    expect(term.modes.sendFocusMode).toBe(true);
    await write('\x1b[?2031l');
    q.themeChanged();
    expect(out).toHaveLength(2);
  });
});

describe('cwd inside workspace (IS-57)', () => {
  const mac = platformCompareOptions(true);
  const linux = platformCompareOptions(false);

  it('normalizes trailing and doubled slashes, . and ..', () => {
    expect(normalizePath('/repo/wt/')).toBe('/repo/wt');
    expect(normalizePath('//repo//wt/./src/..')).toBe('/repo/wt');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/..')).toBe('/');
    expect(normalizePath('')).toBeNull();
    expect(normalizePath('~/code')).toBeNull();
    expect(normalizePath('relative/dir')).toBeNull();
  });

  it('the folder itself and anything under it is inside; a prefix-sharing sibling is not', () => {
    expect(isPathInside('/repo/wt', '/repo/wt')).toBe(true);
    expect(isPathInside('/repo/wt/', '/repo/wt')).toBe(true);
    expect(isPathInside('/repo/wt', '/repo/wt/')).toBe(true);
    expect(isPathInside('/repo/wt/packages/ui', '/repo/wt')).toBe(true);
    expect(isPathInside('/repo/wt-2', '/repo/wt')).toBe(false);
    expect(isPathInside('/repo', '/repo/wt')).toBe(false);
    expect(isPathInside('/repo/wt/..', '/repo/wt')).toBe(false);
    expect(isPathInside('/anything', '/')).toBe(true);
  });

  it('macOS: /tmp, /var, /etc are the same as /private/...; case does not matter', () => {
    expect(isPathInside('/tmp/x/wt/src', '/private/tmp/x/wt', mac)).toBe(true);
    expect(isPathInside('/private/var/folders/wt', '/var/folders/wt', mac)).toBe(true);
    expect(isPathInside('/Users/Me/Code/WT', '/Users/me/code/wt', mac)).toBe(true);
    expect(isPathInside('/private/tmp-other/wt', '/tmp/wt', mac)).toBe(false);
    // Linux 不做这些
    expect(isPathInside('/tmp/x/wt', '/private/tmp/x/wt', linux)).toBe(false);
    expect(isPathInside('/Users/Me/wt', '/Users/me/wt', linux)).toBe(false);
  });

  it('unknown paths give null (no hint)', () => {
    expect(isPathInside('', '/repo/wt')).toBeNull();
    expect(isPathInside('/repo/wt', '')).toBeNull();
  });

  it('outsideWorkspaceTag: tag only when known to be outside, hover shows both paths', () => {
    expect(outsideWorkspaceTag('/repo/wt/src', '/repo/wt')).toBeNull();
    expect(outsideWorkspaceTag(null, '/repo/wt')).toBeNull();
    expect(outsideWorkspaceTag('/somewhere', null)).toBeNull();
    expect(outsideWorkspaceTag('/somewhere', '/repo/wt')).toEqual({ text: 'outside workspace', detail: 'Now in /somewhere\nWorkspace: /repo/wt' });
  });
});
