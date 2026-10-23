// 用真实 git 在临时目录建仓库，给 git-service / workspace-service 的真实实现做集成测试。
// 只能在 Node 里用（主进程、Vitest），所以单独从 '@agentdeck/fakes/temp-repo' 导出，不进 index.ts。

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempCommit {
  subject: string;
  /** 相对仓库根目录 → 文件内容。不给就改一个 log 文件，保证有东西可提交。 */
  files?: Record<string, string>;
}

export interface TempRepoOptions {
  /** 默认 'main'。 */
  defaultBranch?: string;
  /** 默认分支上的提交，旧的在前。默认 3 条：README、src/index.ts、package.json。 */
  commits?: (string | TempCommit)[];
  /** 从默认分支最后一条分出的分支，各自带几条提交。默认一个 feature/login。给空数组就不建。 */
  branches?: { name: string; commits?: (string | TempCommit)[] }[];
  /** 再建一个 bare 仓库当 origin，推上默认分支并设上游（测 ahead / behind、远端默认分支）。 */
  withRemote?: boolean;
  /** 留一些没提交的改动：一个已暂存的新文件、一个改了没暂存的文件、一个未跟踪文件。 */
  dirty?: boolean;
}

export interface TempRepo {
  /** 仓库根目录（已经 realpath，macOS 上是 /private/var/...，和 git 输出一致）。 */
  path: string;
  /** withRemote 时 bare 仓库的路径。 */
  remotePath: string | null;
  defaultBranch: string;
  /** 在仓库里跑 git，返回 stdout（去掉结尾换行）。 */
  git(...args: string[]): string;
  writeFile(relPath: string, content: string): void;
  /** 写文件、git add -A、提交，返回提交哈希。 */
  commit(subject: string, files?: Record<string, string>): string;
  /** 在 parent 目录下新建一个 worktree，返回它的路径（realpath）。 */
  addWorktree(branch: string, opts?: { create?: boolean }): string;
  /** 删掉整个临时目录。 */
  cleanup(): void;
}

const DEFAULT_COMMITS: TempCommit[] = [
  { subject: 'Initial commit', files: { 'README.md': '# Temp repo\n' } },
  { subject: 'Add entry point', files: { 'src/index.ts': 'export const answer = 42;\n' } },
  { subject: 'Add package.json', files: { 'package.json': '{ "name": "temp-repo", "private": true }\n' } },
];

/** 不读用户的全局配置，提交时间固定，结果可重复。 */
function gitEnv(seq: number): NodeJS.ProcessEnv {
  const at = new Date(Date.parse('2026-10-20T09:00:00Z') + seq * 60_000).toISOString();
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'AgentDeck Test',
    GIT_AUTHOR_EMAIL: 'test@agentdeck.invalid',
    GIT_COMMITTER_NAME: 'AgentDeck Test',
    GIT_COMMITTER_EMAIL: 'test@agentdeck.invalid',
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export async function createTempRepo(opts: TempRepoOptions = {}): Promise<TempRepo> {
  const defaultBranch = opts.defaultBranch ?? 'main';
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-repo-')));
  const path = join(root, 'repo');
  mkdirSync(path);
  let seq = 0;

  const run = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, env: gitEnv(seq++), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(
      /\n$/,
      '',
    );
  const git = (...args: string[]): string => run(path, args);
  const writeFile = (relPath: string, content: string): void => {
    const full = join(path, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const commit = (subject: string, files?: Record<string, string>): string => {
    const toWrite = files ?? { 'log.txt': `${subject}\n${seq}\n` };
    for (const [rel, content] of Object.entries(toWrite)) writeFile(rel, content);
    git('add', '-A');
    git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  const doCommits = (list: (string | TempCommit)[]): void => {
    for (const c of list) {
      if (typeof c === 'string') commit(c);
      else commit(c.subject, c.files);
    }
  };

  git('init', '-q', '-b', defaultBranch);
  git('config', 'user.name', 'AgentDeck Test');
  git('config', 'user.email', 'test@agentdeck.invalid');
  git('config', 'commit.gpgsign', 'false');
  doCommits(opts.commits ?? DEFAULT_COMMITS);

  for (const b of opts.branches ?? [{ name: 'feature/login', commits: [{ subject: 'Add login form', files: { 'src/login.ts': 'export function login() {}\n' } }] }]) {
    git('switch', '-q', '-c', b.name, defaultBranch);
    doCommits(b.commits ?? []);
  }
  git('switch', '-q', defaultBranch);

  let remotePath: string | null = null;
  if (opts.withRemote) {
    remotePath = join(root, 'origin.git');
    run(root, ['init', '-q', '--bare', '-b', defaultBranch, remotePath]);
    git('remote', 'add', 'origin', remotePath);
    git('push', '-q', '-u', 'origin', defaultBranch);
    git('remote', 'set-head', 'origin', defaultBranch);
  }

  if (opts.dirty) {
    writeFile('src/new-file.ts', 'export const added = true;\n');
    git('add', 'src/new-file.ts');
    writeFile('README.md', '# Temp repo\n\nEdited but not staged.\n');
    writeFile('notes.txt', 'untracked\n');
  }

  let worktreeCount = 0;
  return {
    path,
    remotePath,
    defaultBranch,
    git,
    writeFile,
    commit,
    addWorktree(branch, o = {}) {
      worktreeCount += 1;
      const wt = join(root, `wt-${worktreeCount}`);
      if (o.create) git('worktree', 'add', '-q', '-b', branch, wt);
      else git('worktree', 'add', '-q', wt, branch);
      return realpathSync(wt);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
