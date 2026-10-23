import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { GitService, IsoTime, ProjectEvent, WorkspaceEvent } from '@agentdeck/contracts';
import type { ProjectRepository, WorkspaceRepository, WorkspaceServiceDeps } from './types.ts';

/** 两个服务共用的依赖，补好默认值。 */
export class Context {
  readonly git: GitService;
  readonly projects: ProjectRepository;
  readonly workspaces: WorkspaceRepository;
  readonly homeDir: string;
  private readonly deps: WorkspaceServiceDeps;

  constructor(deps: WorkspaceServiceDeps) {
    this.deps = deps;
    this.git = deps.git;
    this.projects = deps.projects;
    this.workspaces = deps.workspaces;
    this.homeDir = deps.homeDir ?? homedir();
  }

  now(): IsoTime {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  newId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  tx<T>(fn: () => T): T {
    return this.deps.transaction ? this.deps.transaction(fn) : fn();
  }

  emit(event: ProjectEvent | WorkspaceEvent): void {
    this.deps.emit?.(event);
  }
}
