import type { FileChange, RepoStatus } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { parseDiffLines } from '../src/DiffView.tsx';
import { branchSummary, buildTree, commitLabel, groupChanges, multiCommitLabel, relativeTime, shortPath, type TreeNode } from '../src/model.ts';

const f = (path: string, init: Partial<FileChange> = {}): FileChange => ({
  path,
  fromPath: null,
  staged: 'unmodified',
  unstaged: 'unmodified',
  conflicted: false,
  submodule: false,
  ...init,
});

const status = (files: FileChange[], init: Partial<RepoStatus> = {}): RepoStatus => ({
  repo: '/r',
  branch: 'feat/x',
  head: 'abc',
  upstream: null,
  ahead: 0,
  behind: 0,
  aheadOfBase: 0,
  baseBranch: 'main',
  operation: 'none',
  files,
  at: '2026-10-23T00:00:00Z',
  ...init,
});

describe('groupChanges', () => {
  it('puts conflicts first, and a file staged then edited in both groups', () => {
    const groups = groupChanges([
      f('a.ts', { staged: 'modified', unstaged: 'modified' }),
      f('b.ts', { unstaged: 'untracked' }),
      f('c.ts', { conflicted: true, staged: 'modified', unstaged: 'modified' }),
      f('vendor/lib', { unstaged: 'modified', submodule: true }),
      f('new.ts', { staged: 'renamed', fromPath: 'old.ts' }),
    ]);
    expect(groups.map((g) => [g.title, g.rows.map((r) => `${r.letter} ${r.file.path}`)])).toEqual([
      ['Merge Changes', ['! c.ts']],
      ['Staged Changes', ['M a.ts', 'R new.ts']],
      ['Changes', ['M a.ts', 'U b.ts', 'S vendor/lib']],
    ]);
  });
});

describe('buildTree', () => {
  const names = (nodes: TreeNode[]): unknown[] =>
    nodes.map((n) => (n.type === 'folder' ? { [n.name]: names(n.children) } : n.name));

  it('nests by folder, folders first, and merges single-child chains', () => {
    const rows = groupChanges([
      f('README.md', { unstaged: 'modified' }),
      f('src/auth/oauth.ts', { unstaged: 'untracked' }),
      f('src/auth/oauth.test.ts', { unstaged: 'untracked' }),
      f('src/routes/index.ts', { unstaged: 'modified' }),
      f('src/main.ts', { unstaged: 'modified' }),
      f('docs/guide/intro/a.md', { unstaged: 'modified' }),
    ])[0]!.rows;
    expect(names(buildTree(rows))).toEqual([
      { 'docs/guide/intro': ['a.md'] },
      { src: [{ auth: ['oauth.test.ts', 'oauth.ts'] }, { routes: ['index.ts'] }, 'main.ts'] },
      'README.md',
    ]);
  });
});

describe('labels', () => {
  it('names the commit button after what will be committed', () => {
    expect(commitLabel(status([f('a', { staged: 'added' }), f('b', { unstaged: 'modified' })]))).toBe('Commit 1 file');
    expect(commitLabel(status([f('a', { unstaged: 'modified' }), f('b', { unstaged: 'untracked' })]))).toBe('Commit all 2 changes');
    expect(commitLabel(status([f('a', { unstaged: 'modified' })]))).toBe('Commit 1 change');
    expect(commitLabel(status([]))).toBe('Commit');
    expect(commitLabel(status([f('a', { conflicted: true })], { operation: 'merge' }))).toBe('Complete merge');
    expect(
      multiCommitLabel([
        status([f('a', { unstaged: 'modified' }), f('b', { unstaged: 'modified' }), f('c', { unstaged: 'modified' })]),
        status([f('d', { staged: 'added' }), f('e', { staged: 'added' }), f('f', { unstaged: 'modified' })]),
        status([]),
      ]),
    ).toBe('Commit 5 changes in 2 repos');
  });

  it('summarizes the branch', () => {
    expect(branchSummary(status([], { aheadOfBase: 3 }))).toBe('3 ahead of main');
    expect(branchSummary(status([], { upstream: 'origin/feat/x', ahead: 1, behind: 2 }))).toBe('Even with main · ↑1 ↓2');
    expect(branchSummary(status([], { branch: 'main' }))).toBe('');
    expect(branchSummary(status([], { head: null }))).toBe('No commits yet');
  });

  it('formats times and paths', () => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    expect(relativeTime('2026-10-23T11:59:30Z', now)).toBe('now');
    expect(relativeTime('2026-10-23T11:56:00Z', now)).toBe('4m');
    expect(relativeTime('2026-10-23T10:00:00Z', now)).toBe('2h');
    expect(relativeTime('2026-10-22T10:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-10-20T10:00:00Z', now)).toBe('3d');
    expect(shortPath('/Users/you/.agentdeck/worktrees/agentdeck/feat-login')).toBe('/Users/you/…/agentdeck/feat-login');
    expect(shortPath('/short/path')).toBe('/short/path');
  });

  it('classifies diff lines', () => {
    const lines = parseDiffLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n');
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'del', 'add', 'ctx']);
  });
});
