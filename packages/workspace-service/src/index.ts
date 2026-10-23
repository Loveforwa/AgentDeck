import { Context } from './context.ts';
import { LocalProjectService } from './project-service.ts';
import type { WorkspaceServiceDeps } from './types.ts';
import { LocalWorkspaceService } from './workspace-service.ts';

export { DEFAULT_COPY_INTO_WORKTREES, LocalProjectService } from './project-service.ts';
export { LocalWorkspaceService } from './workspace-service.ts';
export { branchSlug } from './paths.ts';
export type { ProjectRepository, WorkspaceRepository, WorkspaceServiceDeps } from './types.ts';

/** 两个服务共用一份依赖：移除项目时要知道它的工作区，新建工作区时要读项目。 */
export function createWorkspaceServices(deps: WorkspaceServiceDeps): {
  projects: LocalProjectService;
  workspaces: LocalWorkspaceService;
} {
  const ctx = new Context(deps);
  return { projects: new LocalProjectService(ctx), workspaces: new LocalWorkspaceService(ctx) };
}
