import type { BranchInfo, CommitInfo, CommitRef, Workspace, WorkspaceId, WorktreeInfo } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { collapsedBranches, labelsFor, layoutGraph, linePath, strongTips, type GraphContext } from '../src/graph.ts';

function c(hash: string, parents: string[] | undefined, refs?: CommitRef[]): CommitInfo {
  const out: CommitInfo = { hash, shortHash: hash, subject: hash, author: 'a', at: '2026-10-20T09:00:00Z', onBase: false };
  if (parents) out.parents = parents;
  if (refs) out.refs = refs;
  return out;
}

/** 每一行：节点泳道，上半、下半的线（from>to 写成 “1>0”，直线写成 “0”）。 */
function shape(commits: CommitInfo[], strong?: Set<string>) {
  return layoutGraph(commits, strong).rows.map((r) => ({
    hash: r.commit.hash,
    lane: r.lane,
    top: r.top.map((l) => (l.from === l.to ? `${l.from}` : `${l.from}>${l.to}`)),
    bottom: r.bottom.map((l) => (l.from === l.to ? `${l.from}` : `${l.from}>${l.to}`)),
  }));
}

describe('layoutGraph', () => {
  it('draws a straight line for a linear history', () => {
    const { rows, width } = layoutGraph([c('c', ['b']), c('b', ['a']), c('a', [])]);
    expect(width).toBe(1);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0]?.top).toEqual([]);
    expect(rows[2]?.bottom).toEqual([]);
    expect(rows.every((r) => !r.merge)).toBe(true);
  });

  it('treats commits without parents (older services, fakes) as one line', () => {
    expect(shape([c('c', undefined), c('b', undefined), c('a', undefined)])).toEqual([
      { hash: 'c', lane: 0, top: [], bottom: ['0'] },
      { hash: 'b', lane: 0, top: ['0'], bottom: ['0'] },
      { hash: 'a', lane: 0, top: ['0'], bottom: [] },
    ]);
  });

  it('opens a lane for a branch and closes it with an arc at the fork point', () => {
    // feat（f2 → f1）从 b 分出；main 的 m 也从 b 往下
    expect(shape([c('f2', ['f1']), c('m', ['b']), c('f1', ['b']), c('b', ['a']), c('a', [])])).toEqual([
      { hash: 'f2', lane: 0, top: [], bottom: ['0'] },
      { hash: 'm', lane: 1, top: ['0'], bottom: ['0', '1'] },
      { hash: 'f1', lane: 0, top: ['0', '1'], bottom: ['0', '1'] },
      { hash: 'b', lane: 0, top: ['0', '1>0'], bottom: ['0'] },
      { hash: 'a', lane: 0, top: ['0'], bottom: [] },
    ]);
  });

  it('draws a merge as an arc from the merge commit into the merged branch', () => {
    const rows = layoutGraph([c('m', ['b', 'x']), c('x', ['a']), c('b', ['a']), c('a', [])]).rows;
    expect(shape([c('m', ['b', 'x']), c('x', ['a']), c('b', ['a']), c('a', [])])).toEqual([
      { hash: 'm', lane: 0, top: [], bottom: ['0>1', '0'] },
      { hash: 'x', lane: 1, top: ['0', '1'], bottom: ['0', '1'] },
      { hash: 'b', lane: 0, top: ['0', '1'], bottom: ['0', '1'] },
      { hash: 'a', lane: 0, top: ['0', '1>0'], bottom: [] },
    ]);
    expect(rows[0]?.merge).toBe(true);
    expect(rows[0]?.through.map((t) => t.lane)).toEqual([0, 1]);
  });

  it('joins a merge parent that another lane already waits for', () => {
    // t 和 m 都等 x：m 的第二父提交连到 t 那条泳道，不再开新的
    const out = shape([c('t', ['x']), c('m', ['b', 'x']), c('x', ['b']), c('b', [])]);
    expect(out[1]).toEqual({ hash: 'm', lane: 1, top: ['0'], bottom: ['1>0', '0', '1'] });
    expect(out[2]).toEqual({ hash: 'x', lane: 0, top: ['0', '1'], bottom: ['0', '1'] });
    expect(out[3]).toEqual({ hash: 'b', lane: 0, top: ['0', '1>0'], bottom: [] });
  });

  it('reuses freed lanes instead of growing wider', () => {
    // 两个先后分出又各自结束的分支，用同一个位置
    const commits = [
      c('h', ['g']),
      c('s1', ['g']),
      c('g', ['f']),
      c('s2', ['f']),
      c('f', []),
    ];
    const { rows, width } = layoutGraph(commits);
    expect(width).toBe(2);
    expect(rows.find((r) => r.commit.hash === 's2')?.lane).toBe(1);
  });

  it('keeps lanes running to the bottom when the parent is outside the window', () => {
    const { rows } = layoutGraph([c('b', ['a']), c('z', ['outside'])]);
    expect(rows[1]?.bottom.map((l) => l.from)).toEqual([0, 1]);
  });

  it('inks the HEAD and base lines, greys the others', () => {
    const commits = [c('f', ['b']), c('m', ['b']), c('b', [])];
    const { rows } = layoutGraph(commits, new Set(['m']));
    const tone = Object.fromEntries(rows.map((r) => [r.commit.hash, r.tone]));
    expect(tone).toEqual({ f: 1, m: 0, b: 0 });
  });
});

describe('linePath', () => {
  it('is a straight segment or a vertical-ended S curve', () => {
    expect(linePath({ from: 0, to: 0, tone: 0 }, 'top')).toBe('M8 0L8 12');
    expect(linePath({ from: 1, to: 0, tone: 1 }, 'top')).toBe('M20 0C20 6 8 6 8 12');
    expect(linePath({ from: 0, to: 1, tone: 1 }, 'bottom')).toBe('M8 12C8 18 20 18 20 24');
  });
});

// ---- 标签和收起 ----

const ws = (id: string, path: string, name: string, mode: Workspace['mode'] = 'worktree'): Workspace => ({
  id: id as WorkspaceId,
  projectId: 'p' as Workspace['projectId'],
  name,
  mode,
  path,
  branch: null,
  repos: [{ name: '.', path, branch: '' }],
  createdAt: '',
  missing: false,
});

const wt = (path: string, branch: string, main = false): WorktreeInfo => ({ path, branch, head: '0', main });
const br = (name: string, merged: boolean): BranchInfo => ({ name, current: false, checkedOutAt: null, lastCommitAt: null, merged });

const ctx: GraphContext = {
  worktrees: [wt('/r', 'main', true), wt('/w/login', 'feat/login'), wt('/w/stale', 'feat/stale')],
  workspaces: [ws('ws-main', '/r', 'agentdeck', 'main-folder'), ws('ws-login', '/w/login', 'login')],
  branches: [br('main', true), br('feat/login', false), br('feat/stale', true), br('old/a', true), br('spike', false), br('feat/done', true)],
  current: 'feat/login',
  base: 'main',
};

describe('collapsedBranches', () => {
  it('collapses merged branches that no frame on the board uses', () => {
    // feat/stale 在一个不在白板上的 worktree 里检出：也收起
    expect(collapsedBranches(ctx)).toEqual(['feat/done', 'feat/stale', 'old/a']);
    const unknown = ctx.branches.map(({ merged: _merged, ...b }) => b);
    expect(collapsedBranches({ ...ctx, branches: unknown })).toEqual([]);
  });
});

describe('labelsFor', () => {
  const opts = { ...ctx, head: 'h', hidden: new Set(['feat/done']), anyRefs: true };

  it('marks the current branch, frames on the board, and hides collapsed or duplicate remote refs', () => {
    const commit = c('m', [], [
      { name: 'origin/main', kind: 'remote' },
      { name: 'feat/done', kind: 'branch' },
      { name: 'v1', kind: 'tag' },
      { name: 'main', kind: 'branch' },
      { name: 'origin/release', kind: 'remote' },
    ]);
    const labels = labelsFor(commit, opts);
    expect(labels.map((l) => [l.name, l.kind, l.frame?.name ?? null])).toEqual([
      ['main', 'branch', 'agentdeck'],
      ['origin/release', 'remote', null],
      ['v1', 'tag', null],
    ]);
    const head = labelsFor(c('h', [], [{ name: 'feat/login', kind: 'branch', current: true }, { name: 'spike', kind: 'branch' }]), opts);
    expect(head.map((l) => [l.name, l.current, l.frame?.name ?? null])).toEqual([
      ['feat/login', true, 'login'],
      ['spike', false, null],
    ]);
    const stale = labelsFor(c('s', [], [{ name: 'feat/stale', kind: 'branch' }]), opts);
    expect(stale[0]).toMatchObject({ name: 'feat/stale', offBoard: true, frame: null });
  });

  it('falls back to the current branch on HEAD when nothing has refs', () => {
    expect(labelsFor(c('h', undefined), { ...opts, anyRefs: false }).map((l) => [l.name, l.current])).toEqual([['feat/login', true]]);
    expect(labelsFor(c('x', undefined), { ...opts, anyRefs: false })).toEqual([]);
  });
});

describe('strongTips', () => {
  it('is HEAD plus the base branch tip, local or on origin', () => {
    const commits = [c('h', ['b']), c('b', [], [{ name: 'origin/main', kind: 'remote' }])];
    expect([...strongTips(commits, 'h', 'main')].sort()).toEqual(['b', 'h']);
    expect([...strongTips(commits, null, null)]).toEqual([]);
  });
});
