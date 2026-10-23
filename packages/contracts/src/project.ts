// 项目：应用记住的一个本地文件夹。需求见设计画布「2 · 项目」。
// 实现：packages/workspace-service（线 3），运行在主进程。

import type { AbsPath, IsoTime, ProjectId } from './common.ts';

/**
 * git：一个仓库。
 * multi-repo：文件夹本身不是仓库，下一层有 2 个及以上仓库。
 * plain：没有 git，只有主目录工作区。
 */
export type ProjectKind = 'git' | 'multi-repo' | 'plain';

export interface RepoRef {
  /** 单仓库项目里是 '.'；多仓库项目里是子文件夹名，例如 'web'。 */
  name: string;
  path: AbsPath;
  /** 新建工作区时默认从这里分出。自动识别：远端默认分支，其次 main，再次 master。 */
  baseBranch: string;
}

export interface Project {
  id: ProjectId;
  name: string;
  kind: ProjectKind;
  /** 仓库根目录、多仓库的父文件夹，或普通文件夹。 */
  path: AbsPath;
  /** plain 项目为空数组。 */
  repos: RepoRef[];
  /** 默认 ~/.agentdeck/worktrees/<项目名>/ */
  worktreeRoot: AbsPath;
  /** 新建 worktree 时复制过去的文件，默认 ['.env', '.env.local']。 */
  copyIntoWorktrees: string[];
  /** 新建工作区后在框里自动运行，例如 'pnpm install'。 */
  setupCommand: string | null;
  /** 文件夹被移动或删除。界面显示“Folder not found”。 */
  missing: boolean;
  lastUsedAt: IsoTime;
}

/** 选完文件夹后先探测，界面据此决定直接添加还是先问一句。 */
export type ProjectProbe =
  | { kind: 'git'; folder: AbsPath; repoRoot: AbsPath; /** 选的是子文件夹，改用了仓库根目录 */ usedRepoRoot: boolean }
  | { kind: 'multi-repo'; folder: AbsPath; repos: { name: string; path: AbsPath }[] }
  | { kind: 'plain'; folder: AbsPath }
  | { kind: 'already-added'; folder: AbsPath; project: Project };

export interface AddProjectRequest {
  folder: AbsPath;
  /** multi-repo 探测结果可以选 'separately'，每个子仓库各加成一个 git 项目。 */
  as: ProjectKind | 'separately';
}

export type ProjectPatch = Partial<Pick<Project, 'name' | 'worktreeRoot' | 'copyIntoWorktrees' | 'setupCommand'>> & {
  /** 按仓库名改基础分支。 */
  baseBranch?: Record<string, string>;
};

export interface ProjectService {
  probe(folder: AbsPath): Promise<ProjectProbe>;
  /** 'separately' 会返回多个项目。文件夹已经加过时不报错，直接返回已有的项目。 */
  add(req: AddProjectRequest): Promise<Project[]>;
  /** 最近用过的在前。 */
  list(): Promise<Project[]>;
  update(id: ProjectId, patch: ProjectPatch): Promise<Project>;
  /** 只从应用里移除，不删除磁盘上的任何文件。它的工作区一起从白板移除。 */
  remove(id: ProjectId): Promise<void>;
  /** 文件夹找不到时重新指定位置。 */
  locate(id: ProjectId, folder: AbsPath): Promise<Project>;
  /** plain → git：在文件夹里执行 git init。 */
  initGit(id: ProjectId): Promise<Project>;
}

export type ProjectEvent =
  | { type: 'project.changed'; project: Project }
  | { type: 'project.removed'; id: ProjectId };
