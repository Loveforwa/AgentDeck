// 面板用到的纯函数：分组、文件夹树、按钮文字、时间。不碰 React，单测直接调。

import type { ChangeKind, CommitInfo, FileChange, RepoOperation, RepoStatus } from '@agentdeck/contracts';

export type GroupKind = 'merge' | 'staged' | 'changes';

export interface ChangeRow {
  file: FileChange;
  /** 这一组里看的那一半：staged 组看暂存区，changes 组看工作区。 */
  kind: ChangeKind;
  /** M A D R C U !，子模块是 S。 */
  letter: string;
}

export interface ChangeGroup {
  kind: GroupKind;
  title: string;
  rows: ChangeRow[];
}

const LETTER: Partial<Record<ChangeKind, string>> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
};

export const KIND_LABEL: Record<ChangeKind, string> = {
  unmodified: 'Unmodified',
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  untracked: 'Untracked',
  ignored: 'Ignored',
};

/** Merge Changes（冲突）、Staged Changes、Changes。一个文件可以同时在后两组里（暂存后又改了）。 */
export function groupChanges(files: readonly FileChange[]): ChangeGroup[] {
  const merge: ChangeRow[] = [];
  const staged: ChangeRow[] = [];
  const changes: ChangeRow[] = [];
  for (const f of files) {
    if (f.conflicted) {
      merge.push({ file: f, kind: 'modified', letter: '!' });
      continue;
    }
    if (f.staged !== 'unmodified') staged.push({ file: f, kind: f.staged, letter: f.submodule ? 'S' : (LETTER[f.staged] ?? 'M') });
    if (f.unstaged !== 'unmodified' && f.unstaged !== 'ignored')
      changes.push({ file: f, kind: f.unstaged, letter: f.submodule ? 'S' : (LETTER[f.unstaged] ?? 'M') });
  }
  const groups: ChangeGroup[] = [];
  if (merge.length) groups.push({ kind: 'merge', title: 'Merge Changes', rows: merge });
  if (staged.length) groups.push({ kind: 'staged', title: 'Staged Changes', rows: staged });
  if (changes.length) groups.push({ kind: 'changes', title: 'Changes', rows: changes });
  return groups;
}

// ---- 文件夹树 ----

export interface TreeFolder {
  type: 'folder';
  /** 显示的名字；只有一个子文件夹的链会合并成 “src/auth”。 */
  name: string;
  /** 相对仓库根的完整路径。 */
  path: string;
  children: TreeNode[];
}

export interface TreeFile {
  type: 'file';
  name: string;
  path: string;
  row: ChangeRow;
}

export type TreeNode = TreeFolder | TreeFile;

/** 按文件夹把行排成树：文件夹在前、文件在后，各自按名字排；单链文件夹合并。 */
export function buildTree(rows: readonly ChangeRow[]): TreeNode[] {
  const root: TreeFolder = { type: 'folder', name: '', path: '', children: [] };
  for (const row of rows) {
    const parts = row.file.path.replace(/\/$/, '').split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i] ?? '';
      const path = parts.slice(0, i + 1).join('/');
      let next = dir.children.find((c): c is TreeFolder => c.type === 'folder' && c.name === name);
      if (!next) {
        next = { type: 'folder', name, path, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ type: 'file', name: parts[parts.length - 1] ?? row.file.path, path: row.file.path, row });
  }
  return root.children.map(compact).sort(byTypeThenName);
}

function compact(node: TreeNode): TreeNode {
  if (node.type === 'file') return node;
  let n = node;
  while (n.children.length === 1 && n.children[0]?.type === 'folder') {
    const only = n.children[0];
    n = { type: 'folder', name: `${n.name}/${only.name}`, path: only.path, children: only.children };
  }
  return { ...n, children: n.children.map(compact).sort(byTypeThenName) };
}

function byTypeThenName(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function filesUnder(node: TreeNode): ChangeRow[] {
  return node.type === 'file' ? [node.row] : node.children.flatMap(filesUnder);
}

// ---- 提交 ----

export interface CommitPlan {
  /** 这个仓库要不要提交、提交全部还是只提交暂存的。 */
  all: boolean;
  /** 会提交几个文件。 */
  count: number;
}

/** 一个仓库：有暂存就提交暂存的，否则提交全部改动；合并中（冲突都解决了）也可以提交。 */
export function commitPlan(status: RepoStatus | null): CommitPlan | null {
  if (!status) return null;
  const conflicts = status.files.filter((f) => f.conflicted).length;
  if (conflicts > 0) return null;
  const staged = status.files.filter((f) => f.staged !== 'unmodified').length;
  if (staged > 0) return { all: false, count: staged };
  const changes = status.files.filter((f) => f.unstaged !== 'unmodified' && f.unstaged !== 'ignored').length;
  if (changes > 0) return { all: true, count: changes };
  if (status.operation === 'merge') return { all: false, count: 0 };
  return null;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** 单个仓库的提交按钮文字。 */
export function commitLabel(status: RepoStatus | null): string {
  if (status?.operation === 'merge') return 'Complete merge';
  const plan = commitPlan(status);
  if (!plan) return 'Commit';
  if (plan.all) return plan.count === 1 ? 'Commit 1 change' : `Commit all ${plan.count} changes`;
  return `Commit ${plural(plan.count, 'file')}`;
}

/** 多仓库：“Commit 5 changes in 2 repos”。 */
export function multiCommitLabel(statuses: readonly (RepoStatus | null)[]): string {
  const plans = statuses.map(commitPlan).filter((p): p is CommitPlan => p !== null);
  if (plans.length === 0) return 'Commit';
  const total = plans.reduce((n, p) => n + p.count, 0);
  return `Commit ${plural(total, 'change')} in ${plural(plans.length, 'repo')}`;
}

export function operationLabel(op: RepoOperation): string | null {
  switch (op) {
    case 'merge':
      return 'Merging';
    case 'rebase':
      return 'Rebasing';
    case 'cherry-pick':
      return 'Cherry-picking';
    case 'revert':
      return 'Reverting';
    default:
      return null;
  }
}

/** 分支按钮下面那一行：“3 ahead of main · ↑1 ↓2”。 */
export function branchSummary(status: RepoStatus): string {
  const parts: string[] = [];
  if (status.baseBranch && status.branch !== status.baseBranch && status.head)
    parts.push(status.aheadOfBase > 0 ? `${status.aheadOfBase} ahead of ${status.baseBranch}` : `Even with ${status.baseBranch}`);
  if (status.upstream && (status.ahead || status.behind))
    parts.push([status.ahead ? `↑${status.ahead}` : '', status.behind ? `↓${status.behind}` : ''].filter(Boolean).join(' '));
  if (!status.head) parts.push('No commits yet');
  return parts.join(' · ');
}

/** 提交列表：自己分支上的在前，基础分支上的在“On main”分隔线下面。 */
export function splitCommits(commits: readonly CommitInfo[]): { own: CommitInfo[]; onBase: CommitInfo[] } {
  return { own: commits.filter((c) => !c.onBase), onBase: commits.filter((c) => c.onBase) };
}

// ---- 其他 ----

/** “now” “4m” “2h” “yesterday” “3d” “Oct 4”。 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** 长路径中间省略，保留开头和最后两段：/Users/you/…/agentdeck/feat-login。 */
export function shortPath(path: string, max = 44): string {
  if (path.length <= max) return path;
  const parts = path.split('/');
  const tail = parts.slice(-2).join('/');
  const head = parts.slice(0, 3).join('/');
  const s = `${head}/…/${tail}`;
  return s.length < path.length ? s : path;
}

export function baseName(path: string): string {
  const p = path.replace(/\/$/, '');
  return p.slice(p.lastIndexOf('/') + 1);
}

export function joinPath(dir: string, rel: string): string {
  return `${dir.replace(/\/$/, '')}/${rel}`;
}
