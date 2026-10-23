import { describe, expect, it } from 'vitest';
import {
  addressFromHref,
  browserReuseKey,
  displayAddress,
  normalizeAddress,
  pathFromFileHref,
} from '../src/address.ts';
import { BOARD_SOURCE, boardCommand, parseFrameMessage } from '../src/bridge.ts';
import { EMPTY_STACK, canStep, pushEntry, step } from '../src/history.ts';
import { browserWindowType } from '../src/index.ts';

describe('normalizeAddress', () => {
  const ok = (input: string) => {
    const r = normalizeAddress(input);
    if (!r.ok) throw new Error(`expected ok for ${input}: ${r.message}`);
    return r.url;
  };

  it('adds http:// to local hosts and IPs, https:// to others', () => {
    expect(ok('localhost:3000')).toBe('http://localhost:3000/');
    expect(ok('localhost:3000/login?x=1')).toBe('http://localhost:3000/login?x=1');
    expect(ok('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(ok('[::1]:5173')).toBe('http://[::1]:5173/');
    expect(ok('app.localhost:3000')).toBe('http://app.localhost:3000/');
    expect(ok('192.168.1.5:8000')).toBe('http://192.168.1.5:8000/');
    expect(ok('example.com')).toBe('https://example.com/');
    expect(ok('  http://localhost:5173  ')).toBe('http://localhost:5173/');
    expect(ok('https://example.com/a')).toBe('https://example.com/a');
  });

  it('keeps absolute paths and turns file:// urls into paths', () => {
    expect(ok('/Users/me/report.html')).toBe('/Users/me/report.html');
    expect(ok('file:///Users/me/my%20report.html')).toBe('/Users/me/my report.html');
    expect(ok('agentdeck-file:///Users/me/a.html#top')).toBe('/Users/me/a.html#top');
  });

  it('rejects other schemes and nonsense', () => {
    for (const input of ['', 'javascript:alert(1)', 'ftp://localhost/', 'mailto:a@b.c', 'hello', '3000', 'file://host/x']) {
      expect(normalizeAddress(input).ok, input).toBe(false);
    }
  });
});

describe('address helpers', () => {
  it('displayAddress hides http:// and a lone trailing slash', () => {
    expect(displayAddress('http://localhost:3000/')).toBe('localhost:3000');
    expect(displayAddress('http://localhost:3000/login')).toBe('localhost:3000/login');
    expect(displayAddress('https://example.com/')).toBe('https://example.com/');
    expect(displayAddress('/Users/me/a.html')).toBe('/Users/me/a.html');
  });

  it('addressFromHref turns agentdeck-file:// back into a path', () => {
    expect(addressFromHref('agentdeck-file:///Users/me/a%20b.html')).toBe('/Users/me/a b.html');
    expect(addressFromHref('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(pathFromFileHref('agentdeck-file://host/x')).toBeNull();
  });

  it('browserReuseKey uses the origin, or the path for files', () => {
    expect(browserReuseKey('http://localhost:5173/about')).toBe('http://localhost:5173');
    expect(browserReuseKey('http://localhost:5173/')).toBe(browserReuseKey('http://localhost:5173/x?y'));
    expect(browserReuseKey('/Users/me/a.html#top')).toBe('/Users/me/a.html');
  });
});

describe('bridge messages', () => {
  it('accepts location and key messages from the frame bridge', () => {
    expect(
      parseFrameMessage({ source: 'agentdeck-frame', type: 'location', href: 'http://x/', canGoBack: true }),
    ).toEqual({ type: 'location', href: 'http://x/', title: '', canGoBack: true, canGoForward: false });
    expect(parseFrameMessage({ source: 'agentdeck-frame', type: 'key', key: 'reload' })).toEqual({
      type: 'key',
      key: 'reload',
    });
  });

  it('ignores anything else', () => {
    for (const data of [
      null,
      'x',
      { type: 'location', href: 'http://x/' },
      { source: 'agentdeck-frame', type: 'location' },
      { source: 'agentdeck-frame', type: 'key', key: 'quit' },
      { source: 'other', type: 'key', key: 'back' },
    ]) {
      expect(parseFrameMessage(data)).toBeNull();
    }
  });

  it('builds board commands', () => {
    expect(boardCommand('back')).toEqual({ source: BOARD_SOURCE, type: 'back' });
  });
});

describe('fallback history', () => {
  it('pushes, steps and truncates forward entries', () => {
    let s = pushEntry(pushEntry(pushEntry(EMPTY_STACK, 'a'), 'b'), 'c');
    expect(canStep(s, -1)).toBe(true);
    expect(canStep(s, 1)).toBe(false);
    const back = step(s, -1);
    expect(back?.url).toBe('b');
    s = back!.stack;
    expect(canStep(s, 1)).toBe(true);
    s = pushEntry(s, 'd');
    expect(s.entries).toEqual(['a', 'b', 'd']);
    expect(step(s, 1)).toBeNull();
  });

  it('does not duplicate the current entry', () => {
    const s = pushEntry(pushEntry(EMPTY_STACK, 'a'), 'a');
    expect(s.entries).toEqual(['a']);
  });
});

describe('browserWindowType', () => {
  it('defaults to 640×420 and an empty frame-mode page', () => {
    expect(browserWindowType.type).toBe('browser');
    expect(browserWindowType.defaultSize).toEqual({ w: 640, h: 420 });
    expect(browserWindowType.create({})).toEqual({ url: '', mode: 'frame' });
    expect(browserWindowType.create({ url: 'http://localhost:3000/' })).toEqual({
      url: 'http://localhost:3000/',
      mode: 'frame',
    });
  });
});
