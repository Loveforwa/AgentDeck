// DC0：parseCodeRefs。一张表一行一种情况（同 port-watch 的 link-cases 的思路）。
import { describe, expect, it } from 'vitest';
import type { CodeRef } from '../src/index.ts';
import { parseCodeRefs } from '../src/index.ts';

type Expect = Partial<Pick<CodeRef, 'path' | 'start' | 'end' | 'rev' | 'symbol' | 'kind' | 'raw' | 'source'>>;

const cases: [name: string, markdown: string, refs: Expect[]][] = [
  ['path:line', 'See packages/contracts/src/board.ts:275 for it.', [{ path: 'packages/contracts/src/board.ts', start: 275, kind: 'repo', raw: 'packages/contracts/src/board.ts:275' }]],
  ['path:start-end', 'In `src/a.ts:12-30`.', [{ path: 'src/a.ts', start: 12, end: 30, raw: 'src/a.ts:12-30' }]],
  ['path:line:col', 'Error at src/a.ts:12:5 here', [{ path: 'src/a.ts', start: 12, raw: 'src/a.ts:12:5' }]],
  ['path#La-Lb (GitHub)', 'packages/ui/widgets/terminal/src/TerminalWindow.tsx#L243-L247', [{ path: 'packages/ui/widgets/terminal/src/TerminalWindow.tsx', start: 243, end: 247 }]],
  ['@path#La-b (claude)', 'Look at @src/auth/refresh.ts#L5-10 first', [{ path: 'src/auth/refresh.ts', start: 5, end: 10, raw: 'src/auth/refresh.ts#L5-10' }]],
  ['path#La', 'src/a.ts#L7', [{ path: 'src/a.ts', start: 7 }]],
  ['path@rev:line (pinned)', 'packages/mcp-server/src/tools.ts@871dd81:279', [{ path: 'packages/mcp-server/src/tools.ts', rev: '871dd81', start: 279 }]],
  ['symbol after the ref', 'packages/contracts/src/board.ts:275 `WindowTypeDefinition`', [{ start: 275, symbol: 'WindowTypeDefinition' }]],
  ['symbol after a backticked ref', '`TerminalWindow.tsx:243-247` `onLink` handles it', [{ path: 'TerminalWindow.tsx', symbol: 'onLink' }]],
  ['symbol with ()', 'src/a.ts:3 `parseCodeRefs()`', [{ symbol: 'parseCodeRefs' }]],
  ['short path', 'claude.ts:83 decides', [{ path: 'claude.ts', start: 83, kind: 'repo' }]],
  ['absolute path', '/Users/you/app/src/a.ts:4', [{ path: '/Users/you/app/src/a.ts', start: 4 }]],
  ['(new)', 'Add apps/desktop/src/main/sessions.ts (new) for it', [{ path: 'apps/desktop/src/main/sessions.ts', kind: 'new', raw: 'apps/desktop/src/main/sessions.ts (new)' }]],
  ['external source', 'openai/codex main (2026-10-26) features/src/lib.rs:40-52', [{ path: 'features/src/lib.rs', kind: 'external', start: 40, end: 52, source: 'openai/codex main (2026-10-26)' }]],
  ['several on one line', 'a.ts:1 and b/c.ts:2-3', [{ path: 'a.ts', start: 1 }, { path: 'b/c.ts', start: 2, end: 3 }]],
  ['url is not a ref', 'Open https://github.com/me/app/blob/main/src/a.ts:3 or http://localhost:5173/a.ts:3', []],
  ['link target is not a ref', 'See [the code](src/a.ts:3)', []],
  ['host:port is not a ref', 'Serve on example.com:8080 and 127.0.0.1:3000', []],
  ['no extension, no line', 'node:fs at 10:42, and src/a.ts alone', []],
  ['inside a word', 'xsrc/a.ts:3 is fine but foo@src/a.ts:3 is not', [{ path: 'xsrc/a.ts', start: 3 }]],
];

describe('parseCodeRefs', () => {
  it.each(cases)('%s', (_name, markdown, expected) => {
    const refs = parseCodeRefs(markdown);
    expect(refs).toHaveLength(expected.length);
    expected.forEach((e, i) => expect(refs[i]).toMatchObject(e));
  });

  it('skips fenced code blocks', () => {
    const md = ['Before src/a.ts:1', '```ts', 'import x from "src/b.ts:2";', '```', '~~~', 'src/c.ts:3', '~~~', 'After src/d.ts:4'].join('\n');
    expect(parseCodeRefs(md).map((r) => r.path)).toEqual(['src/a.ts', 'src/d.ts']);
  });

  it('records where each ref is, so line numbers can be fixed in place', () => {
    const md = 'Title\n\nSee `src/a.ts:12-30` and @src/b.ts#L5';
    const [a, b] = parseCodeRefs(md);
    expect(a?.at).toEqual({ from: md.indexOf('src/a.ts'), to: md.indexOf('src/a.ts') + 'src/a.ts:12-30'.length, line: 3 });
    expect(md.slice(a!.at.from, a!.at.to)).toBe(a!.raw);
    expect(md.slice(b!.at.from, b!.at.to)).toBe('src/b.ts#L5');
  });
});
