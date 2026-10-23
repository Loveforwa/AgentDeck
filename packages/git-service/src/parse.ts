// git 输出的解析，都是纯函数，单测直接喂文本。

import type { AbsPath, BranchInfo, ChangeKind, FileChange, IsoTime, StashInfo, WorktreeInfo } from '@agentdeck/contracts';

// ---- status --porcelain=v2 -z --branch ----

export interface ParsedStatus {
  /** 分离 HEAD 时为 null。 */
  branch: string | null;
  /** 还没有提交时为 null。 */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileChange[];
}

function kindOf(code: string): ChangeKind {
  switch (code) {
    case 'M':
    case 'T': // 类型变了（文件 ↔ 符号链接），界面上当修改
    case 'U':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return 'unmodified';
  }
}

/** 冲突时 XY 的含义和普通条目不同：U 表示“两边都改了”，A/D 是那一边加了或删了。 */
function conflictKinds(xy: string): { staged: ChangeKind; unstaged: ChangeKind } {
  const map = (c: string): ChangeKind => (c === 'A' ? 'added' : c === 'D' ? 'deleted' : 'modified');
  return { staged: map(xy[0] ?? 'U'), unstaged: map(xy[1] ?? 'U') };
}

/** 按空格切出前 n 个字段，剩下的（路径，可能带空格）整个作为最后一个。 */
function splitFields(line: string, n: number): string[] | null {
  const out: string[] = [];
  let rest = line;
  for (let i = 0; i < n; i++) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    out.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }
  out.push(rest);
  return out;
}

export function parseStatusV2(out: string): ParsedStatus {
  const result: ParsedStatus = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] ?? '';
    if (e === '') continue;
    if (e.startsWith('# ')) {
      const [key, ...vals] = e.slice(2).split(' ');
      const val = vals.join(' ');
      if (key === 'branch.oid') result.head = val === '(initial)' ? null : val;
      else if (key === 'branch.head') result.branch = val === '(detached)' ? null : val;
      else if (key === 'branch.upstream') result.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) {
          result.ahead = Number(m[1]);
          result.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = e[0];
    if (type === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const f = splitFields(e, 8);
      if (!f) continue;
      const xy = f[1] ?? '..';
      result.files.push({
        path: f[8] ?? '',
        fromPath: null,
        staged: kindOf(xy[0] ?? '.'),
        unstaged: kindOf(xy[1] ?? '.'),
        conflicted: false,
        submodule: (f[2] ?? 'N').startsWith('S'),
      });
    } else if (type === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
      const f = splitFields(e, 9);
      if (!f) continue;
      const xy = f[1] ?? '..';
      const fromPath = entries[i + 1] ?? null;
      i += 1;
      result.files.push({
        path: f[9] ?? '',
        fromPath,
        staged: kindOf(xy[0] ?? '.'),
        unstaged: kindOf(xy[1] ?? '.'),
        conflicted: false,
        submodule: (f[2] ?? 'N').startsWith('S'),
      });
    } else if (type === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const f = splitFields(e, 10);
      if (!f) continue;
      result.files.push({
        path: f[10] ?? '',
        fromPath: null,
        ...conflictKinds(f[1] ?? 'UU'),
        conflicted: true,
        submodule: (f[2] ?? 'N').startsWith('S'),
      });
    } else if (type === '?' || type === '!') {
      const path = e.slice(2);
      result.files.push({
        path,
        fromPath: null,
        staged: 'unmodified',
        unstaged: type === '?' ? 'untracked' : 'ignored',
        conflicted: false,
        // 未跟踪的子模块（别人 clone 进来的仓库）git 显示为目录 “name/”
        submodule: false,
      });
    }
  }
  return result;
}

// ---- worktree list --porcelain -z ----

export function parseWorktrees(out: string): WorktreeInfo[] {
  const records: { path: AbsPath; head: string; branch: string | null; bare: boolean }[] = [];
  for (const field of out.split('\0')) {
    if (field === '') continue;
    const sp = field.indexOf(' ');
    const key = sp < 0 ? field : field.slice(0, sp);
    const val = sp < 0 ? '' : field.slice(sp + 1);
    const cur = records[records.length - 1];
    if (key === 'worktree') records.push({ path: val, head: '', branch: null, bare: false });
    else if (!cur) continue;
    else if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'bare') cur.bare = true;
  }
  // 第一条是主 worktree；bare 仓库没有工作目录，不列出
  return records
    .map((r, i) => ({ path: r.path, branch: r.branch, head: r.head, main: i === 0, bare: r.bare }))
    .filter((r) => !r.bare)
    .map(({ bare: _bare, ...r }) => r);
}

// ---- for-each-ref refs/heads ----

/** 字段：refname:short、HEAD（* 表示当前）、worktreepath、committerdate:iso-strict，用 \0 分隔，一行一个分支。 */
export const BRANCH_FORMAT = '%(refname:short)%00%(HEAD)%00%(worktreepath)%00%(committerdate:iso-strict)';

export function parseBranches(out: string): BranchInfo[] {
  const list: BranchInfo[] = [];
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const [name = '', head = '', wt = '', date = ''] = line.split('\0');
    list.push({
      name,
      current: head === '*',
      checkedOutAt: wt === '' ? null : wt,
      lastCommitAt: date === '' ? null : toIso(date),
    });
  }
  return list;
}

// ---- log ----

/** 字段：完整哈希、短哈希、作者、提交时间、标题，\0 分隔；记录之间用 \x1e。 */
export const LOG_FORMAT = '%H%x00%h%x00%an%x00%cI%x00%s%x1e';

export interface ParsedCommit {
  hash: string;
  shortHash: string;
  author: string;
  at: IsoTime;
  subject: string;
}

export function parseLog(out: string): ParsedCommit[] {
  const list: ParsedCommit[] = [];
  for (const rec of out.split('\x1e')) {
    const r = rec.replace(/^\n/, '');
    if (r === '') continue;
    const [hash = '', shortHash = '', author = '', at = '', subject = ''] = r.split('\0');
    list.push({ hash, shortHash, author, at: toIso(at), subject });
  }
  return list;
}

// ---- stash list ----

/** 字段：stash@{n}、reflog 标题（“On main: msg” / “WIP on main: abc subject”）、时间。 */
export const STASH_FORMAT = '%gd%x00%gs%x00%cI%x1e';

export function parseStashes(out: string): StashInfo[] {
  const list: StashInfo[] = [];
  for (const rec of out.split('\x1e')) {
    const r = rec.replace(/^\n/, '');
    if (r === '') continue;
    const [id = '', subject = '', at = ''] = r.split('\0');
    const m = /^(WIP on|On) (.+?): (.*)$/s.exec(subject);
    let branch: string | null = null;
    let message = subject;
    if (m) {
      branch = m[2] === '(no branch)' ? null : (m[2] ?? null);
      message = m[1] === 'On' ? (m[3] ?? '') : subject;
    }
    list.push({ id, branch, message, at: toIso(at) });
  }
  return list;
}

/** git 的 iso-strict 带本地时区（+08:00），统一成 UTC 的 ISO 字符串，界面排序和比较才一致。 */
export function toIso(text: string): IsoTime {
  const t = Date.parse(text);
  return Number.isNaN(t) ? text : new Date(t).toISOString();
}
