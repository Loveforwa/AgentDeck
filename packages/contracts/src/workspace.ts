// 工作区：项目 + 一个工作目录 + 一个分支，白板上是一个框。需求见「4 · 工作区框」。
// 实现：packages/workspace-service（线 3），运行在主进程，git 操作通过 GitService。

import type { AbsPath, IsoTime, ProjectId, WorkspaceId } from './common.ts';

/** worktree：新建的 worktree；main-folder：项目主目录（每个项目最多一个）。 */
export type WorkspaceMode = 'worktree' | 'main-folder';

export type BranchChoice =
  | {
      kind: 'new';
      name: string;
      /**
       * 从哪个分支分出。不填时每个仓库用自己的基础分支（RepoRef.baseBranch），多仓库项目里通常不填。
       * 填了就对每个仓库按名字解析，某个仓库没有这个分支时抛 not-found，已建好的回滚。
       */
      from?: string;
    }
  | { kind: 'existing'; name: string };

export interface CreateWorkspaceRequest {
  projectId: ProjectId;
  mode: WorkspaceMode;
  /** mode 为 worktree 时必填；plain 项目不能填。 */
  branch?: BranchChoice;
  /** 多仓库项目：要带上的仓库名。不填就是全部。 */
  repos?: string[];
  /** 不填时用分支名，主目录工作区用项目名。 */
  name?: string;
}

export interface WorkspaceRepo {
  /** 单仓库是 '.'，多仓库是子文件夹名。 */
  name: string;
  path: AbsPath;
  /** plain 项目为 null。 */
  branch: string | null;
}

export interface Workspace {
  id: WorkspaceId;
  projectId: ProjectId;
  name: string;
  mode: WorkspaceMode;
  /** agent 和终端的工作目录。多仓库时是父目录。 */
  path: AbsPath;
  /** 分支名；多仓库时所有仓库同名；plain 项目为 null。 */
  branch: string | null;
  repos: WorkspaceRepo[];
  createdAt: IsoTime;
  /** 目录被删除或移动。框显示“Folder not found”。 */
  missing: boolean;
}

export interface CreateWorkspaceResult {
  workspace: Workspace;
  /** 需要在框里新开一个 Shell 运行的初始化命令。由应用层负责开终端。 */
  setup: { command: string; cwd: AbsPath } | null;
}

export interface RemoveWorkspaceRequest {
  id: WorkspaceId;
  /** false：只从白板移除；true：同时删除 worktree 文件夹（分支保留）。 */
  deleteFolder: boolean;
  /**
   * deleteFolder 为 true 且 worktree 里有未提交的改动时：false（默认）抛 dirty-worktree，界面确认后带 true 再调一次；
   * true 直接删除，改动丢失。
   */
  force?: boolean;
}

export interface WorkspaceService {
  /** 多仓库时任何一个仓库失败，已经建好的全部回滚。 */
  create(req: CreateWorkspaceRequest): Promise<CreateWorkspaceResult>;
  list(): Promise<Workspace[]>;
  rename(id: WorkspaceId, name: string): Promise<Workspace>;
  remove(req: RemoveWorkspaceRequest): Promise<void>;
}

export type WorkspaceEvent =
  | {
      type: 'workspace.progress';
      projectId: ProjectId;
      step: 'worktree' | 'copy-files' | 'done';
      /** 正在建的工作区的分支名，同一个项目同时建两个工作区时用来区分。主目录工作区没有。 */
      branch?: string;
      repo?: string;
      message: string;
    }
  | { type: 'workspace.changed'; workspace: Workspace }
  | { type: 'workspace.removed'; id: WorkspaceId };
