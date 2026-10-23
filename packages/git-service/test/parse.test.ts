import { describe, expect, it } from 'vitest';
import { parseBranches, parseLog, parseStashes, parseStatusV2, parseWorktrees } from '../src/index.ts';

const Z = '\0';

describe('parseStatusV2', () => {
  it('reads branch headers', () => {
    const s = parseStatusV2(
      ['# branch.oid abc123', '# branch.head feat/x', '# branch.upstream origin/feat/x', '# branch.ab +2 -1', ''].join(Z),
    );
    expect(s).toMatchObject({ head: 'abc123', branch: 'feat/x', upstream: 'origin/feat/x', ahead: 2, behind: 1, files: [] });
  });

  it('handles an unborn branch and a detached HEAD', () => {
    expect(parseStatusV2(`# branch.oid (initial)${Z}# branch.head main${Z}`)).toMatchObject({ head: null, branch: 'main' });
    expect(parseStatusV2(`# branch.oid abc${Z}# branch.head (detached)${Z}`)).toMatchObject({ head: 'abc', branch: null });
  });

  it('reads ordinary, renamed, conflicted, untracked and submodule entries', () => {
    const out = [
      '1 M. N... 100644 100644 100644 aaa bbb src/a file.ts',
      '1 .D N... 100644 100644 000000 aaa aaa gone.ts',
      '2 R. N... 100644 100644 100644 aaa aaa R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 a b c both.ts',
      'u AU N... 000000 100644 100644 100644 a b c added-by-us.ts',
      '1 .M SC.. 160000 160000 160000 aaa aaa vendor/lib',
      '? notes/todo.md',
      '! dist/out.js',
      '',
    ].join(Z);
    const { files } = parseStatusV2(out);
    expect(files).toEqual([
      { path: 'src/a file.ts', fromPath: null, staged: 'modified', unstaged: 'unmodified', conflicted: false, submodule: false },
      { path: 'gone.ts', fromPath: null, staged: 'unmodified', unstaged: 'deleted', conflicted: false, submodule: false },
      { path: 'new name.ts', fromPath: 'old name.ts', staged: 'renamed', unstaged: 'unmodified', conflicted: false, submodule: false },
      { path: 'both.ts', fromPath: null, staged: 'modified', unstaged: 'modified', conflicted: true, submodule: false },
      { path: 'added-by-us.ts', fromPath: null, staged: 'added', unstaged: 'modified', conflicted: true, submodule: false },
      { path: 'vendor/lib', fromPath: null, staged: 'unmodified', unstaged: 'modified', conflicted: false, submodule: true },
      { path: 'notes/todo.md', fromPath: null, staged: 'unmodified', unstaged: 'untracked', conflicted: false, submodule: false },
      { path: 'dist/out.js', fromPath: null, staged: 'unmodified', unstaged: 'ignored', conflicted: false, submodule: false },
    ]);
  });
});

describe('parseWorktrees', () => {
  it('marks the first entry as main and reads branches and detached HEADs', () => {
    const out = [
      'worktree /r/main',
      'HEAD 111',
      'branch refs/heads/main',
      '',
      'worktree /r/wt one',
      'HEAD 222',
      'detached',
      '',
      'worktree /r/wt-2',
      'HEAD 333',
      'branch refs/heads/feat/x',
      'locked',
      '',
      '',
    ].join(Z);
    expect(parseWorktrees(out)).toEqual([
      { path: '/r/main', branch: 'main', head: '111', main: true },
      { path: '/r/wt one', branch: null, head: '222', main: false },
      { path: '/r/wt-2', branch: 'feat/x', head: '333', main: false },
    ]);
  });

  it('leaves out a bare main repository', () => {
    const out = ['worktree /r/bare.git', 'bare', '', 'worktree /r/wt', 'HEAD 1', 'branch refs/heads/x', '', ''].join(Z);
    expect(parseWorktrees(out)).toEqual([{ path: '/r/wt', branch: 'x', head: '1', main: false }]);
  });
});

describe('parseBranches / parseLog / parseStashes', () => {
  it('reads for-each-ref lines', () => {
    const out = `main${Z}*${Z}/r/main${Z}2026-10-20T17:00:00+08:00\nfeat/x${Z} ${Z}${Z}2026-10-20T09:30:00+00:00\n`;
    expect(parseBranches(out)).toEqual([
      { name: 'main', current: true, checkedOutAt: '/r/main', lastCommitAt: '2026-10-20T09:00:00.000Z' },
      { name: 'feat/x', current: false, checkedOutAt: null, lastCommitAt: '2026-10-20T09:30:00.000Z' },
    ]);
  });

  it('reads log records', () => {
    const out = `aaaa${Z}aa${Z}Ann${Z}2026-10-20T09:00:00Z${Z}feat: one\x1e\nbbbb${Z}bb${Z}Bo${Z}2026-10-20T08:00:00Z${Z}fix: two: colon\x1e\n`;
    expect(parseLog(out)).toEqual([
      { hash: 'aaaa', shortHash: 'aa', author: 'Ann', at: '2026-10-20T09:00:00.000Z', subject: 'feat: one' },
      { hash: 'bbbb', shortHash: 'bb', author: 'Bo', at: '2026-10-20T08:00:00.000Z', subject: 'fix: two: colon' },
    ]);
  });

  it('reads stash subjects and the branch they came from', () => {
    const out = [
      `stash@{0}${Z}On feat/x: AgentDeck: switched to main${Z}2026-10-20T09:00:00Z\x1e`,
      `stash@{1}${Z}WIP on main: abc123 Add thing${Z}2026-10-20T08:00:00Z\x1e`,
      `stash@{2}${Z}On (no branch): detached work${Z}2026-10-20T07:00:00Z\x1e`,
    ].join('\n');
    expect(parseStashes(out)).toEqual([
      { id: 'stash@{0}', branch: 'feat/x', message: 'AgentDeck: switched to main', at: '2026-10-20T09:00:00.000Z' },
      { id: 'stash@{1}', branch: 'main', message: 'WIP on main: abc123 Add thing', at: '2026-10-20T08:00:00.000Z' },
      { id: 'stash@{2}', branch: null, message: 'detached work', at: '2026-10-20T07:00:00.000Z' },
    ]);
  });
});
