import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TerminalLink } from '@agentdeck/contracts';
import { createLinkWatcher, findLinkMatches, findLinks, stripAnsi } from '../src/index.ts';

const { cases } = JSON.parse(readFileSync(new URL('./link-cases.json', import.meta.url), 'utf8')) as {
  cases: { line: string; links: TerminalLink[] }[];
};

describe('link-cases.json', () => {
  it('the terminal window keeps an identical copy (packages/ui/widgets/terminal/test/link-cases.json)', () => {
    const copy = readFileSync(new URL('../../ui/widgets/terminal/test/link-cases.json', import.meta.url), 'utf8');
    expect(copy).toBe(readFileSync(new URL('./link-cases.json', import.meta.url), 'utf8'));
  });
});

describe('findLinks', () => {
  for (const c of cases) {
    it(JSON.stringify(c.line), () => {
      expect(findLinks(c.line)).toEqual(c.links);
    });
  }
});

describe('findLinkMatches', () => {
  it('gives the range of the link text in the line', () => {
    const line = '(see http://localhost:3000/docs) and src/a.ts:3:1.';
    const ms = findLinkMatches(line);
    expect(ms.map((m) => line.slice(m.start, m.end))).toEqual(['http://localhost:3000/docs', 'src/a.ts:3:1']);
    const bare = 'ready on localhost:3000.';
    expect(findLinkMatches(bare).map((m) => bare.slice(m.start, m.end))).toEqual(['localhost:3000']);
  });
});

describe('stripAnsi', () => {
  it('removes colors and keeps text', () => {
    expect(stripAnsi('\x1b[1;32mready\x1b[0m on \x1b[36mhttp://localhost:3000/\x1b[39m')).toBe('ready on http://localhost:3000/');
  });

  it('turns cursor positioning into line breaks and cursor-forward into spaces', () => {
    expect(stripAnsi('\x1b[1;1Hrow one\x1b[2;1Hrow two')).toBe('\nrow one\nrow two');
    expect(stripAnsi('a\x1b[3Cb')).toBe('a b');
  });

  it('pulls the target out of OSC 8 hyperlinks and drops other OSC / DCS', () => {
    expect(stripAnsi('\x1b]8;;http://localhost:3000/\x1b\\click\x1b]8;;\x1b\\')).toBe('\nhttp://localhost:3000/\nclick');
    expect(stripAnsi('\x1b]0;title\x07x\x1bPtmux;\x1b\x1b]9;hi\x07\x1b\\y')).toBe('xy');
  });

  it('handles CR, CRLF and backspace', () => {
    expect(stripAnsi('50%\r100%\r\ndone')).toBe('50%\n100%\ndone');
    expect(stripAnsi('abc\b\bX')).toBe('aX');
  });
});

describe('createLinkWatcher', () => {
  it('finds links across chunks and split escape sequences', () => {
    const w = createLinkWatcher();
    expect(w.push('  Local:   \x1b[36mhttp://local')).toEqual([]);
    expect(w.push('host:5173/\x1b[')).toEqual([]);
    expect(w.push('39m\r\n')).toEqual([{ kind: 'localhost', url: 'http://localhost:5173/' }]);
  });

  it('flush picks up the last line without a newline', () => {
    const w = createLinkWatcher();
    expect(w.push('ready on localhost:3000')).toEqual([]);
    expect(w.flush()).toEqual([{ kind: 'localhost', url: 'http://localhost:3000/' }]);
    expect(w.flush()).toEqual([]);
  });

  it('joins a URL that the program wrapped at the pane width', () => {
    const w = createLinkWatcher({ cols: 30 });
    const url = 'http://localhost:3000/some/very/long/path';
    const out = w.push(`${url.slice(0, 30)}\r\n${url.slice(30)}\r\n`);
    expect(out).toEqual([{ kind: 'localhost', url }]);
  });

  it('does not join lines that are shorter than the pane', () => {
    const w = createLinkWatcher({ cols: 80 });
    expect(w.push('ready on http://localhost:3000\r\nGET / 200\r\n')).toEqual([{ kind: 'localhost', url: 'http://localhost:3000/' }]);
  });

  it('works with a ratatui-style screen drawn by cursor positioning', () => {
    const w = createLinkWatcher();
    const out = w.push('\x1b[3;5H\x1b[1mServer\x1b[0m http://localhost:8000/\x1b[4;5HEdited src/main.rs:42\x1b[5;1H');
    expect(out).toEqual([
      { kind: 'localhost', url: 'http://localhost:8000/' },
      { kind: 'file', path: 'src/main.rs', line: 42 },
    ]);
  });
});
