// DC1：代码锚点用的 blameLines、showFile、lineMap（以及给 doc-service 的 renamedPath、listFiles），在真实的临时仓库上跑。
// 场景：插行、改行、删文件、改名、没提交的改动。

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDeckError } from '@agentdeck/contracts';
import { createTempRepo, type TempRepo } from '@agentdeck/fakes/temp-repo';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBlamePorcelain, parseHunks, parseRenames } from '../src/index.ts';
import { makeGit } from './helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const ZERO = '0'.repeat(40);
const lines = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`);
const text = (ls: string[]) => `${ls.join('\n')}\n`;

/** src/x.ts 10 行（c1），之后在第 3 行前插 2 行（c2）。 */
async function repo(): Promise<{ r: TempRepo; c1: string; c2: string }> {
  const r = await createTempRepo({ commits: [{ subject: 'Init', files: { 'README.md': '# Temp\n' } }], branches: [] });
  cleanups.push(() => r.cleanup());
  const c1 = r.commit('Add x', { 'src/x.ts': text(lines(10)), 'src/old.ts': text(lines(5, 'old')) });
  const x = lines(10);
  x.splice(2, 0, 'inserted a', 'inserted b');
  const c2 = r.commit('Insert two lines', { 'src/x.ts': text(x) });
  return { r, c1, c2 };
}

async function rejection(p: Promise<unknown>): Promise<AgentDeckError> {
  try {
    await p;
  } catch (e) {
    return e as AgentDeckError;
  }
  throw new Error('expected the promise to reject');
}

describe('blameLines', () => {
  it('gives the commit of every line, with uncommitted lines as zeros', async () => {
    const { r, c1, c2 } = await repo();
    const x = lines(10);
    x.splice(2, 0, 'inserted a', 'inserted b');
    x[5] = 'edited, not committed';
    r.writeFile('src/x.ts', text(x));
    const { git } = makeGit();
    const blame = await git.blameLines(r.path, 'src/x.ts');
    expect(blame.map((b) => b.line)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(blame.map((b) => b.commit)).toEqual([c1, c1, c2, c2, c1, ZERO, c1, c1, c1, c1, c1, c1]);
  });

  it('blames an older version', async () => {
    const { r, c1 } = await repo();
    const { git } = makeGit();
    const blame = await git.blameLines(r.path, 'src/x.ts', { rev: c1 });
    expect(blame).toHaveLength(10);
    expect(new Set(blame.map((b) => b.commit))).toEqual(new Set([c1]));
  });

  it('follows a committed rename back to the original commit', async () => {
    const { r, c1 } = await repo();
    r.git('mv', 'src/old.ts', 'src/new.ts');
    r.git('commit', '-q', '-m', 'Rename old to new');
    const { git } = makeGit();
    expect(new Set((await git.blameLines(r.path, 'src/new.ts')).map((b) => b.commit))).toEqual(new Set([c1]));
  });

  it('treats an untracked file as all uncommitted and a missing one as not found', async () => {
    const { r, c1 } = await repo();
    r.writeFile('docs/draft.md', 'one\ntwo\nthree');
    const { git } = makeGit();
    expect(await git.blameLines(r.path, 'docs/draft.md')).toEqual([
      { line: 1, commit: ZERO },
      { line: 2, commit: ZERO },
      { line: 3, commit: ZERO },
    ]);
    expect((await rejection(git.blameLines(r.path, 'src/nope.ts'))).code).toBe('not-found');
    expect((await rejection(git.blameLines(r.path, 'docs/draft.md', { rev: c1 }))).code).toBe('not-found');
    rmSync(join(r.path, 'src/x.ts'));
    expect((await rejection(git.blameLines(r.path, 'src/x.ts'))).code).toBe('not-found');
    expect((await rejection(git.blameLines(r.path, 'src/x.ts', { rev: '--evil' }))).code).toBe('invalid-argument');
  });
});

describe('showFile', () => {
  it('reads a file at a version, null when that version has no such file', async () => {
    const { r, c1, c2 } = await repo();
    r.git('rm', '-q', 'src/old.ts');
    r.git('commit', '-q', '-m', 'Delete old');
    const { git } = makeGit();
    expect(await git.showFile(r.path, c1, 'src/x.ts')).toBe(text(lines(10)));
    expect((await git.showFile(r.path, c2, 'src/x.ts'))?.split('\n')[2]).toBe('inserted a');
    expect(await git.showFile(r.path, 'HEAD~1', './src/old.ts')).toBe(text(lines(5, 'old')));
    expect(await git.showFile(r.path, 'HEAD', 'src/old.ts')).toBeNull();
    expect(await git.showFile(r.path, 'HEAD', 'src')).toBeNull(); // 目录不是文件
    expect((await rejection(git.showFile(r.path, 'no-such-branch', 'src/x.ts'))).code).toBe('not-found');
  });
});

describe('lineMap', () => {
  it('maps inserted lines between two commits', async () => {
    const { r, c1, c2 } = await repo();
    const { git } = makeGit();
    expect(await git.lineMap(r.path, 'src/x.ts', c1, c2)).toEqual([{ oldStart: 2, oldLines: 0, newStart: 3, newLines: 2 }]);
    expect(await git.lineMap(r.path, 'src/x.ts', c2, c2)).toEqual([]);
  });

  it('maps against the working tree, including uncommitted inserts and edits', async () => {
    const { r, c1 } = await repo();
    const x = lines(10);
    x.splice(2, 0, 'inserted a', 'inserted b');
    x.unshift('', '', ''); // 不提交：顶上再插 3 行
    x[3 + 2 + 6] = 'line 7 changed'; // 原来的第 7 行
    r.writeFile('src/x.ts', text(x));
    const { git } = makeGit();
    expect(await git.lineMap(r.path, 'src/x.ts', c1, 'worktree')).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 },
      { oldStart: 2, oldLines: 0, newStart: 6, newLines: 2 },
      { oldStart: 7, oldLines: 1, newStart: 12, newLines: 1 },
    ]);
    expect(await git.lineMap(r.path, 'src/old.ts', c1, 'worktree')).toEqual([]);
  });

  it('shows a deleted file as one hunk that removes every line', async () => {
    const { r, c1 } = await repo();
    rmSync(join(r.path, 'src/old.ts'));
    const { git } = makeGit();
    expect(await git.lineMap(r.path, 'src/old.ts', c1, 'worktree')).toEqual([{ oldStart: 1, oldLines: 5, newStart: 0, newLines: 0 }]);
  });

  it('follows a rename, committed or only staged, and gives hunks for the renamed file', async () => {
    const { r, c1 } = await repo();
    const moved = lines(5, 'old');
    moved.splice(1, 0, 'new second line');
    r.git('mv', 'src/old.ts', 'src/new.ts');
    r.writeFile('src/new.ts', text(moved));
    r.git('add', '-A');
    const { git } = makeGit();
    // 只暂存了改名
    expect(await git.renamedPath(r.path, 'src/old.ts', c1)).toBe('src/new.ts');
    expect(await git.lineMap(r.path, 'src/old.ts', c1, 'worktree')).toEqual([{ oldStart: 1, oldLines: 0, newStart: 2, newLines: 1 }]);
    // 提交以后
    const c3 = r.commit('Rename old to new');
    expect(await git.renamedPath(r.path, 'src/old.ts', c1, c3)).toBe('src/new.ts');
    expect(await git.lineMap(r.path, 'src/old.ts', c1, c3)).toEqual([{ oldStart: 1, oldLines: 0, newStart: 2, newLines: 1 }]);
    expect(await git.renamedPath(r.path, 'src/x.ts', c1, c3)).toBeNull();
  });
});

describe('listFiles', () => {
  it('lists tracked and untracked files but not ignored ones', async () => {
    const { r } = await repo();
    r.writeFile('.gitignore', 'dist/\n');
    r.writeFile('dist/out.md', 'built\n');
    r.writeFile('docs/new.md', 'draft\n');
    const { git } = makeGit();
    expect(await git.listFiles(r.path)).toEqual(['.gitignore', 'README.md', 'docs/new.md', 'src/old.ts', 'src/x.ts']);
  });
});

describe('anchor parsers', () => {
  it('reads blame --porcelain headers and skips content lines', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const out = [
      `${a} 1 1 2`,
      'author x',
      'summary looks like a header',
      'filename f',
      '\tfirst',
      `${a} 2 2`,
      `\t${b} 9 9 9`,
      `${b} 7 3 1`,
      'previous c f',
      'filename f',
      '\tthird',
      '',
    ].join('\n');
    expect(parseBlamePorcelain(out)).toEqual([
      { line: 1, commit: a },
      { line: 2, commit: a },
      { line: 3, commit: b },
    ]);
  });

  it('reads @@ headers with and without counts', () => {
    const out = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -3 +3 @@ fn', '-a', '+@@ -1 +1 @@', '@@ -10,0 +11,2 @@', '+x', '+y', '@@ -20,3 +22,0 @@'].join('\n');
    expect(parseHunks(out)).toEqual([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
      { oldStart: 10, oldLines: 0, newStart: 11, newLines: 2 },
      { oldStart: 20, oldLines: 3, newStart: 22, newLines: 0 },
    ]);
  });

  it('reads renames from name-status -z', () => {
    expect(parseRenames('R100\0a.ts\0b.ts\0R087\0c d.ts\0e.ts\0C100\0f.ts\0g.ts\0')).toEqual(
      new Map([
        ['a.ts', 'b.ts'],
        ['c d.ts', 'e.ts'],
      ]),
    );
  });
});
