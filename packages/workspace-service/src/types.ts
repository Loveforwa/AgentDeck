// 本包要的依赖。仓储的形状和 packages/store 的 ProjectRepository / WorkspaceRepository 一样，
// 但不能 import store（模块边界：workspace-service 只能直接用 git-service），所以在这里按结构再写一遍。
// apps/desktop 组装时直接把 openStore() 返回的 store.projects / store.workspaces 传进来。

import type {
  AbsPath,
  GitService,
  IsoTime,
  Project,
  ProjectEvent,
  ProjectId,
  Workspace,
  WorkspaceEvent,
  WorkspaceId,
} from '@agentdeck/contracts';

export interface ProjectRepository {
  /** 最近用过的在前。 */
  list(): Project[];
  get(id: ProjectId): Project | null;
  findByPath(path: AbsPath): Project | null;
  put(project: Project): void;
  touch(id: ProjectId, at: IsoTime): boolean;
  /** 连同它的工作区一起删掉。 */
  remove(id: ProjectId): boolean;
}

export interface WorkspaceRepository {
  list(): Workspace[];
  listByProject(projectId: ProjectId): Workspace[];
  get(id: WorkspaceId): Workspace | null;
  put(workspace: Workspace): void;
  remove(id: WorkspaceId): boolean;
}

export interface WorkspaceServiceDeps {
  /** 真实的是 @agentdeck/git-service 的 createGitService()。 */
  git: GitService;
  projects: ProjectRepository;
  workspaces: WorkspaceRepository;
  /** 几步写入放进一个事务（store.transaction）。不传就直接执行。 */
  transaction?: <T>(fn: () => T) => T;
  /** 发 project.* / workspace.* 事件。 */
  emit?: (event: ProjectEvent | WorkspaceEvent) => void;
  /** 默认 os.homedir()。worktree 默认放在 <home>/.agentdeck/worktrees/<项目名>/。 */
  homeDir?: string;
  now?: () => Date;
  newId?: () => string;
}
