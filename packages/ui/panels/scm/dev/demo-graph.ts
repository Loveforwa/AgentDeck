// dev 页面用的示范提交图（N5）：假实现的 log 不认 graph / commit，没有分叉和合并可看。
// 照设计画布 N5 那张图编的：main 上合并过两个分支，feat/login（白板上的框）还没合并，还有几条已合并的旧分支。

import type { BranchInfo, CommitFile, CommitInfo, CommitRef, LogOptions } from '@agentdeck/contracts';

const MIN = 60_000;

function commit(hash: string, subject: string, parents: string[], minutesAgo: number, refs: CommitRef[] = []): CommitInfo {
  return {
    hash: hash.padEnd(40, '0'),
    shortHash: hash.slice(0, 7),
    subject,
    author: 'AgentDeck Dev',
    at: new Date(Date.now() - minutesAgo * MIN).toISOString(),
    onBase: false,
    parents: parents.map((p) => p.padEnd(40, '0')),
    refs,
  };
}

/** head：面板所在目录的 HEAD（假实现 status 给的），换到当前分支顶端那条上。 */
export function demoGraph(currentBranch: string | null, head: string | null): CommitInfo[] {
  const onLogin = currentBranch === 'feat/login';
  const list = [
    commit('a1b2c3d', 'Add login form', ['7771e36'], 2, [{ name: 'feat/login', kind: 'branch', ...(onLogin ? { current: true } : {}) }]),
    commit('443e7d4', 'Plan round 2 and the next phase', ['45d4b22'], 5, [
      { name: 'main', kind: 'branch', ...(currentBranch === 'main' ? { current: true } : {}) },
      { name: 'origin/main', kind: 'remote' },
    ]),
    commit('45d4b22', 'Merge feat/M1-mcp', ['c0e5f66', '7771e36'], 60),
    commit('7771e36', 'M1: Clawd, a pixel mascot', ['085ac71'], 70, [{ name: 'feat/M1-mcp', kind: 'branch' }]),
    commit('c0e5f66', 'Merge x13-known-agents', ['9855a37', 'c0d317f'], 120),
    commit('c0d317f', 'X13: list agents by label', ['9855a37'], 130, [{ name: 'x13-known-agents', kind: 'branch' }]),
    commit('085ac71', 'M1: start the MCP in the main process', ['39d4653'], 180),
    commit('9855a37', 'Board: center the window on restore', ['39d4653'], 190),
    commit('39d4653', 'M1: packages/mcp-server', ['225ec4d'], 240, [{ name: 'v0.1', kind: 'tag' }]),
    commit('225ec4d', 'docs: one numbering scheme', ['0c0ffee'], 300),
    commit('0c0ffee', 'Initial commit', [], 600),
  ];
  const base = new Set(['443e7d4', '45d4b22', '7771e36', 'c0e5f66', 'c0d317f', '085ac71', '9855a37', '39d4653', '225ec4d', '0c0ffee']);
  // HEAD 那条换成假实现 status 给的哈希，面板才画实心点
  const tip = list.find((c) => c.refs?.some((r) => r.current));
  const swap = (h: string) => (head && tip && h === tip.hash ? head : h);
  return list.map((c) => ({
    ...c,
    hash: swap(c.hash),
    shortHash: swap(c.hash).slice(0, 7),
    parents: c.parents?.map(swap) ?? [],
    onBase: base.has(c.shortHash),
  }));
}

export function demoLog(currentBranch: string | null, head: string | null, opts: LogOptions): CommitInfo[] {
  const all = demoGraph(currentBranch, head);
  if (opts.commit) {
    const c = all.find((x) => x.hash === opts.commit);
    return c ? [{ ...c, files: demoFiles(c) }] : [];
  }
  if (opts.graph?.branches) return all.filter((c) => !['c0d317f', 'c0e5f66'].includes(c.shortHash) || c.onBase);
  return all;
}

function demoFiles(c: CommitInfo): CommitFile[] {
  const n = (parseInt(c.shortHash.slice(0, 2), 16) % 4) + 1;
  return [
    { path: 'packages/ui/panels/scm/src/CommitGraph.tsx', fromPath: null, kind: 'added' as const },
    { path: 'packages/ui/panels/scm/src/scm.css', fromPath: null, kind: 'modified' as const },
    { path: 'docs/notes.md', fromPath: 'docs/old-notes.md', kind: 'renamed' as const },
    { path: 'README.md', fromPath: null, kind: 'deleted' as const },
  ].slice(0, n);
}

/** 已合并的旧分支（不在白板上）：图上收成一行。 */
export function demoBranches(real: BranchInfo[]): BranchInfo[] {
  const merged = ['feat/M1-mcp', 'x13-known-agents', 'worktree-agent-1', 'worktree-agent-2', 'fix/IS-41'];
  const names = new Set(real.map((b) => b.name));
  const extra = merged.filter((n) => !names.has(n)).map((name) => ({ name, current: false, checkedOutAt: null, lastCommitAt: null }));
  return [...real, ...extra].map((b) => ({ ...b, merged: b.name === 'main' || merged.includes(b.name) }));
}
