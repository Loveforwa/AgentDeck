// ProjectService 的假实现。文件夹是不是仓库、有没有子仓库，都问 FakeGitService。

import type {
  AbsPath,
  AddProjectRequest,
  Project,
  ProjectId,
  ProjectPatch,
  ProjectProbe,
  ProjectService,
  RepoRef,
} from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';
import { FakeGitService } from './git-service.ts';
import { basename, clone, fail, idGenerator, nowIso } from './util.ts';

export interface FakeProjectServiceOptions {
  bus?: FakeEventBus;
  git?: FakeGitService;
  /** 用户主目录，默认 worktreeRoot 用。默认 '/Users/you'。 */
  home?: AbsPath;
}

export class FakeProjectService implements ProjectService {
  readonly bus: FakeEventBus;
  readonly git: FakeGitService;
  private readonly home: AbsPath;
  private readonly projects = new Map<ProjectId, Project>();
  /** lastUsedAt 相同时按这个排，后用的在前。 */
  private readonly usedOrder = new Map<ProjectId, number>();
  private useCounter = 0;
  private readonly nextId = idGenerator();

  constructor(opts: FakeProjectServiceOptions = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
    this.git = opts.git ?? new FakeGitService({ bus: this.bus });
    this.home = opts.home ?? '/Users/you';
  }

  async probe(folder: AbsPath): Promise<ProjectProbe> {
    const added = this.byPath(folder);
    if (added) return { kind: 'already-added', folder, project: clone(added) };
    const root = await this.git.repoRoot(folder);
    if (root) {
      const addedRoot = this.byPath(root);
      if (addedRoot) return { kind: 'already-added', folder, project: clone(addedRoot) };
      return { kind: 'git', folder, repoRoot: root, usedRepoRoot: root !== folder };
    }
    const children = this.childRepos(folder);
    if (children.length >= 2) return { kind: 'multi-repo', folder, repos: children };
    return { kind: 'plain', folder };
  }

  async add(req: AddProjectRequest): Promise<Project[]> {
    const probe = await this.probe(req.folder);
    if (probe.kind === 'already-added') {
      this.touch(probe.project.id);
      return [clone(this.require(probe.project.id))];
    }
    const created: Project[] = [];
    if (req.as === 'git') {
      if (probe.kind !== 'git') fail('not-a-git-repo', `${req.folder} is not a git repository`);
      created.push(this.insert(probe.repoRoot, 'git', [await this.repoRef('.', probe.repoRoot)]));
    } else if (req.as === 'multi-repo' || req.as === 'separately') {
      if (probe.kind !== 'multi-repo') fail('invalid-argument', `${req.folder} does not contain several repositories`);
      if (req.as === 'multi-repo') {
        const repos = await Promise.all(probe.repos.map((r) => this.repoRef(r.name, r.path)));
        created.push(this.insert(req.folder, 'multi-repo', repos));
      } else {
        for (const r of probe.repos) created.push(this.insert(r.path, 'git', [await this.repoRef('.', r.path)]));
      }
    } else {
      created.push(this.insert(req.folder, 'plain', []));
    }
    for (const p of created) this.emitChanged(p);
    return created.map((p) => clone(p));
  }

  async list(): Promise<Project[]> {
    return [...this.projects.values()]
      .sort(
        (a, b) =>
          b.lastUsedAt.localeCompare(a.lastUsedAt) || (this.usedOrder.get(b.id) ?? 0) - (this.usedOrder.get(a.id) ?? 0),
      )
      .map((p) => clone(p));
  }

  async update(id: ProjectId, patch: ProjectPatch): Promise<Project> {
    const p = this.require(id);
    const { baseBranch, ...rest } = patch;
    for (const [repoName, branch] of Object.entries(baseBranch ?? {})) {
      const repo = p.repos.find((r) => r.name === repoName);
      if (!repo) fail('invalid-argument', `No repository named ${repoName}`);
      repo.baseBranch = branch;
      // 让假 git 的 aheadOfBase / log 也按新的基础分支算；仓库不在假 git 里就算了
      if (this.git.repoPaths().includes(repo.path)) this.git.setBaseBranch(repo.path, branch);
    }
    if (rest.name !== undefined && !rest.name.trim()) fail('invalid-argument', 'Project name is empty');
    Object.assign(p, clone(rest));
    this.emitChanged(p);
    return clone(p);
  }

  async remove(id: ProjectId): Promise<void> {
    this.require(id);
    this.projects.delete(id);
    this.usedOrder.delete(id);
    this.bus.emit({ type: 'project.removed', id });
  }

  async locate(id: ProjectId, folder: AbsPath): Promise<Project> {
    const p = this.require(id);
    const root = p.kind === 'git' ? await this.git.repoRoot(folder) : null;
    if (p.kind === 'git') {
      if (!root) fail('not-a-git-repo', `${folder} is not a git repository`);
      p.path = root;
      p.repos = p.repos.map((r) => ({ ...r, path: root }));
    } else if (p.kind === 'multi-repo') {
      const children = this.childRepos(folder);
      const repos = p.repos.map((r) => {
        const child = children.find((c) => c.name === r.name);
        if (!child) fail('not-found', `Repository ${r.name} not found in ${folder}`);
        return { ...r, path: child.path };
      });
      p.path = folder;
      p.repos = repos;
    } else {
      p.path = folder;
    }
    p.missing = false;
    this.emitChanged(p);
    return clone(p);
  }

  async initGit(id: ProjectId): Promise<Project> {
    const p = this.require(id);
    if (p.kind !== 'plain') fail('invalid-argument', 'This project already uses git');
    await this.git.init(p.path);
    p.kind = 'git';
    p.repos = [await this.repoRef('.', p.path)];
    this.emitChanged(p);
    return clone(p);
  }

  // ---- 假实现专用 ----

  /** 直接放进一个项目（预置数据用），不发事件。 */
  seed(project: Project): void {
    this.projects.set(project.id, clone(project));
    this.usedOrder.set(project.id, ++this.useCounter);
  }

  /** 模拟文件夹被移走（或找回来）。 */
  setMissing(id: ProjectId, missing: boolean): void {
    const p = this.require(id);
    p.missing = missing;
    this.emitChanged(p);
  }

  /** 同步取一个项目（内部对象，别改）。找不到抛 not-found。 */
  get(id: ProjectId): Readonly<Project> {
    return this.require(id);
  }

  touch(id: ProjectId): void {
    this.require(id).lastUsedAt = nowIso();
    this.usedOrder.set(id, ++this.useCounter);
  }

  // ---- 内部 ----

  private require(id: ProjectId): Project {
    const p = this.projects.get(id);
    if (!p) fail('not-found', `Project ${id} not found`);
    return p;
  }

  private byPath(path: AbsPath): Project | undefined {
    return [...this.projects.values()].find((p) => p.path === path);
  }

  private childRepos(folder: AbsPath): { name: string; path: AbsPath }[] {
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    return this.git
      .repoPaths()
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .sort()
      .map((path) => ({ name: basename(path), path }));
  }

  private async repoRef(name: string, path: AbsPath): Promise<RepoRef> {
    return { name, path, baseBranch: await this.git.defaultBranch(path) };
  }

  private insert(path: AbsPath, kind: Project['kind'], repos: RepoRef[]): Project {
    const name = basename(path);
    const p: Project = {
      id: this.nextId<ProjectId>('prj'),
      name,
      kind,
      path,
      repos,
      worktreeRoot: `${this.home}/.agentdeck/worktrees/${name}`,
      copyIntoWorktrees: ['.env', '.env.local'],
      setupCommand: null,
      missing: false,
      lastUsedAt: nowIso(),
    };
    this.projects.set(p.id, p);
    this.usedOrder.set(p.id, ++this.useCounter);
    return p;
  }

  private emitChanged(p: Project): void {
    this.bus.emit({ type: 'project.changed', project: clone(p) });
  }
}
