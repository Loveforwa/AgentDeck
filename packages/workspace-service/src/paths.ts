import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { AgentDeckError, type AbsPath } from '@agentdeck/contracts';

/** worktree 目录名：feat/oauth → feat-oauth。 */
export function branchSlug(branch: string): string {
  const slug = branch
    .replace(/[/\\]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug === '' ? 'branch' : slug;
}

/** 项目名做目录名：去掉路径分隔符，其他原样。 */
export function folderName(name: string): string {
  const n = name.replace(/[/\\:]+/g, '-').trim();
  return n === '' || n === '.' || n === '..' ? 'project' : n;
}

/** 选的文件夹：必须存在、是目录；返回真实路径（macOS 上 /var → /private/var，和 git 的输出一致）。 */
export function existingFolder(folder: AbsPath): AbsPath {
  const abs = resolve(folder);
  if (!existsSync(abs) || !statSync(abs).isDirectory())
    throw new AgentDeckError({ code: 'not-found', message: `Folder not found: ${folder}` });
  return realpathSync(abs);
}

/** path 已经存在时依次试 path-2、path-3……，返回第一个不存在的。 */
export function unusedPath(path: AbsPath, taken: (p: AbsPath) => boolean = () => false): AbsPath {
  if (!existsSync(path) && !taken(path)) return path;
  for (let i = 2; ; i++) {
    const p = `${path}-${i}`;
    if (!existsSync(p) && !taken(p)) return p;
  }
}

/** 复制进 worktree 的条目只能是仓库里的相对路径。 */
export function safeRelative(entry: string): string | null {
  if (entry.trim() === '' || isAbsolute(entry)) return null;
  const n = normalize(entry);
  if (n === '..' || n.startsWith(`..${sep}`)) return null;
  return n;
}
