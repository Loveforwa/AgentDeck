// 测试仓库：在沙盒里建，带 main 分支、几次提交、一个不进 git 的 .env（新建 worktree 时应该被复制过去）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, type Sandbox } from './sandbox.ts';

export interface RepoOptions {
  /** 额外的分支：名字 → 在这个分支上提交的文件。 */
  branches?: Record<string, Record<string, string>>;
  /** 写进 .env（不提交）。 */
  env?: string;
}

export function makeRepo(sb: Sandbox, name: string, opts: RepoOptions = {}): string {
  const dir = join(sb.reposDir, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(sb, dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), `# ${name}\n\nAgentDeck e2e fixture.\n`);
  writeFileSync(join(dir, 'src/app.txt'), 'hello\n');
  writeFileSync(join(dir, '.gitignore'), '.env\nnode_modules/\n');
  git(sb, dir, ['add', '-A']);
  git(sb, dir, ['commit', '-q', '-m', 'Initial commit']);
  writeFileSync(join(dir, 'src/app.txt'), 'hello\nworld\n');
  git(sb, dir, ['commit', '-q', '-am', 'Second commit']);
  for (const [branch, files] of Object.entries(opts.branches ?? {})) {
    git(sb, dir, ['switch', '-q', '-c', branch]);
    for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
    git(sb, dir, ['add', '-A']);
    git(sb, dir, ['commit', '-q', '-m', `Work on ${branch}`]);
    git(sb, dir, ['switch', '-q', 'main']);
    git(sb, dir, ['merge', '-q', '--no-ff', '-m', `Merge ${branch}`, branch]);
  }
  writeFileSync(join(dir, '.env'), opts.env ?? 'SECRET=e2e\n');
  return dir;
}
