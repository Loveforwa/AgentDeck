// 行号映射、找原文、找符号、行级 diff 的单元测试。

import { describe, expect, it } from 'vitest';
import { classify, diffLines, findBlock, findSymbol, interesting, mapLine, oldLength, splitLines, touches } from '../src/lines.ts';

const L = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} number ${i + 1}`);

describe('splitLines', () => {
  it('splits like git does', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('mapLine and touches', () => {
  // 第 2 行后插 3 行；第 7 行改成 2 行；第 10–11 行删掉
  const hunks = [
    { oldStart: 2, oldLines: 0, newStart: 3, newLines: 3 },
    { oldStart: 7, oldLines: 1, newStart: 10, newLines: 2 },
    { oldStart: 10, oldLines: 2, newStart: 13, newLines: 0 },
  ];
  it('shifts lines after inserts and replacements', () => {
    expect(mapLine(hunks, 1, 'start')).toBe(1);
    expect(mapLine(hunks, 2, 'start')).toBe(2);
    expect(mapLine(hunks, 3, 'start')).toBe(6);
    expect(mapLine(hunks, 8, 'start')).toBe(12);
    expect(mapLine(hunks, 12, 'start')).toBe(14);
  });
  it('points into a changed or deleted block', () => {
    expect(mapLine(hunks, 7, 'start')).toBe(10);
    expect(mapLine(hunks, 7, 'end')).toBe(11);
    expect(mapLine(hunks, 10, 'start')).toBe(14);
    expect(mapLine(hunks, 11, 'end')).toBe(13);
  });
  it('knows which ranges were touched', () => {
    expect(touches(hunks, 3, 6)).toBe(false);
    expect(touches(hunks, 1, 2)).toBe(false); // 插在第 2 行之后，不在 1–2 中间
    expect(touches(hunks, 2, 3)).toBe(true); // 插在 2 和 3 中间
    expect(touches(hunks, 6, 8)).toBe(true);
    expect(touches(hunks, 11, 11)).toBe(true);
    // 新文件 15 行：15 - (3) - (2 - 1) - (0 - 2) = 13 行旧文件
    expect(oldLength(15, hunks)).toBe(13);
  });
});

describe('classify', () => {
  it('moves untouched lines, finds a block git aligned differently, and reports changed and gone', () => {
    const base = L(20);
    const now = ['', '', '', ...L(20)];
    now[3 + 9] = 'line number 10 edited';
    const hunks = diffLines(base, now);
    expect(classify(base, now, hunks, 4, 6)).toEqual({ kind: 'same', start: 7, end: 9 });
    expect(classify(base, now, hunks, 10, 10)).toEqual({ kind: 'changed', start: 13, end: 13 });
    // 整段删掉
    const cut = base.filter((_, i) => i < 4 || i > 7);
    expect(classify(base, cut, diffLines(base, cut), 5, 8)).toMatchObject({ kind: 'gone', detail: 'These lines were deleted' });
    // 一段挪到了文件后面：hunk 碰到了，但原文还在
    const moved = [...base.slice(0, 2), ...base.slice(5), ...base.slice(2, 5)];
    expect(classify(base, moved, diffLines(base, moved), 3, 5)).toEqual({ kind: 'same', start: 18, end: 20 });
  });

  it('needs the symbol near the new range', () => {
    const base = ['export function foo() {', '  return 1;', '}', ...L(40)];
    const now = [...L(30, 'pad'), ...base];
    const hunks = diffLines(base, now);
    expect(classify(base, now, hunks, 1, 3, 'foo')).toEqual({ kind: 'same', start: 31, end: 33 });
    expect(classify(base, now, hunks, 1, 3, 'bar')).toMatchObject({ kind: 'gone' });
    const renamed = [...base];
    renamed[1] = '  return 2;';
    expect(classify(base, renamed, diffLines(base, renamed), 1, 3, 'foo')).toEqual({ kind: 'changed', start: 1, end: 3 });
  });
});

describe('findBlock and findSymbol', () => {
  it('picks the nearest copy and ignores trivial lines', () => {
    const lines = ['a = 1;', '}', 'value = 2;', 'x', 'value = 2;'];
    expect(findBlock(lines, ['value = 2;'], 5)).toBe(5);
    expect(findBlock(lines, ['value = 2;'], 1)).toBe(3);
    expect(findBlock(lines, ['}'], 2)).toBeNull();
    expect(interesting('  });')).toBe(false);
    expect(interesting('return x;')).toBe(true);
  });
  it('matches whole identifiers and the last part of a dotted name', () => {
    const lines = ['const fooBar = 1;', 'export const foo = 2;', 'api.app.openInEditor(path)'];
    expect(findSymbol(lines, 'foo', 1, 1)).toBe(2);
    expect(findSymbol(lines, 'app.openInEditor', 1, 1)).toBe(3);
    expect(findSymbol(lines, 'Board.openInEditor', 1, 1)).toBe(3);
    expect(findSymbol(lines, 'missing', 1, 3)).toBeNull();
    expect(findSymbol([...L(30), 'target'], 'target', 1, 1)).toBeNull(); // 超出 ±20 行
  });
});

describe('diffLines', () => {
  it('gives git-style hunks', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'y', 'b', 'c'])).toEqual([{ oldStart: 1, oldLines: 0, newStart: 2, newLines: 2 }]);
    expect(diffLines(['a', 'b', 'c'], ['a', 'c'])).toEqual([{ oldStart: 2, oldLines: 1, newStart: 1, newLines: 0 }]);
    expect(diffLines(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual([{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }]);
    expect(diffLines([], ['a'])).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }]);
  });

  it('maps every untouched line onto the same text (random edits)', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round += 1) {
      const a = Array.from({ length: 5 + rnd(60) }, (_, i) => `l${i} ${rnd(4)}`);
      const b = [...a];
      for (let k = rnd(6); k > 0; k -= 1) {
        const at = rnd(b.length + 1);
        const op = rnd(3);
        if (op === 0) b.splice(at, 0, `new ${round} ${k}`);
        else if (op === 1 && b.length > 1) b.splice(at, 1);
        else if (at < b.length) b[at] = `changed ${round} ${k}`;
      }
      const hunks = diffLines(a, b);
      expect(oldLength(b.length, hunks)).toBe(a.length);
      for (let i = 1; i <= a.length; i += 1)
        if (!touches(hunks, i, i)) expect(b[mapLine(hunks, i, 'start') - 1]).toBe(a[i - 1]);
    }
  });
});
