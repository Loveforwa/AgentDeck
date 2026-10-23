// ProjectService：添加、探测、改设置、移除项目。需求见「2 · 项目」。
// 项目只记在库里，移除时不碰磁盘上的任何文件。

import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type {
  AbsPath,
  AddProjectRequest,
  Project,
  ProjectId,
  ProjectPatch,
  ProjectProbe,
  ProjectService,
  RepoRef,
  Workspace,
} from '@agentdeck/contracts';
import { AgentDeckError } from '@agentdeck/contracts';
import type { Context } from './context.ts';
import { existingFolder, folderName, unusedPath } from './paths.ts';

export const DEFAULT_COPY_INTO_WORKTREES = ['.env', '.env.local'];

/** 不当成子仓库去看的文件夹。 */
const SKIP_DIRS = new Set(['node_modules']);

export class LocalProjectService implements ProjectService {
  constructor(private readonly ctx: Context) {}

  async probe(folder: AbsPath): Promise<ProjectProbe> {
    const dir = existingFolder(folder);
    const root = await this.ctx.git.repoRoot(dir);
    if (root) {
      const existing = this.ctx.projects.findByPath(root);
      if (existing) return { kind: 'already-added', folder: dir, project: existing };
      return { kind: 'git', folder: dir, repoRoot: root, usedRepoRoot: root !== dir };
    }
    const existing = this.ctx.projects.findByPath(dir);
    if (existing) return { kind: 'already-added', folder: dir, project: existing };
    const repos = await this.childRepos(dir);
    if (repos.length >= 2) return { kind: 'multi-repo', folder: dir, repos };
    return { kind: 'plain', folder: dir };
  }

  async add(req: AddProjectRequest): Promise<Project[]> {
    const probe = await this.probe(req.folder);
    if (probe.kind === 'already-added') return [probe.project];

    if (req.as === 'separately') {
      if (probe.kind !== 'multi-repo') throw notAllowed(req.as, probe.kind);
      const added: Project[] = [];
      for (const r of probe.repos) added.push(...(await this.add({ folder: r.path, as: 'git' })));
      return added;
    }
    if (req.as === 'git') {
      if (probe.kind !== 'git') throw notAllowed(req.as, probe.kind);
      return [await this.create('git', probe.repoRoot, [{ name: '.', path: probe.repoRoot }])];
    }
    if (req.as === 'multi-repo') {
      if (probe.kind !== 'multi-repo') throw notAllowed(req.as, probe.kind);
      return [await this.create('multi-repo', probe.folder, probe.repos)];
    }
    // plain：没有 git 的文件夹；多仓库的父文件夹也可以当普通文件夹加
    if (probe.kind === 'git') throw notAllowed(req.as, probe.kind);
    return [await this.create('plain', probe.folder, [])];
  }

  async list(): Promise<Project[]> {
    const out: Project[] = [];
    for (const p of this.ctx.projects.list()) out.push(await this.refresh(p));
    return out;
  }

  async update(id: ProjectId, patch: ProjectPatch): Promise<Project> {
    const p = this.get(id);
    const next: Project = { ...p };
    if (patch.name !== undefined) {
      if (patch.name.trim() === '') throw invalid('Project name is empty');
      next.name = patch.name.trim();
    }
    if (patch.worktreeRoot !== undefined) {
      if (!isAbsolute(patch.worktreeRoot)) throw invalid('Worktree location must be an absolute path');
      next.worktreeRoot = patch.worktreeRoot;
    }
    if (patch.copyIntoWorktrees !== undefined) next.copyIntoWorktrees = patch.copyIntoWorktrees.filter((s) => s.trim() !== '');
    if (patch.setupCommand !== undefined) next.setupCommand = patch.setupCommand?.trim() || null;
    if (patch.baseBranch) {
      const names = new Set(p.repos.map((r) => r.name));
      for (const name of Object.keys(patch.baseBranch))
        if (!names.has(name)) throw invalid(`${p.name} has no repository named ${name}`);
      next.repos = p.repos.map((r) => ({ ...r, baseBranch: patch.baseBranch?.[r.name] ?? r.baseBranch }));
    }
    this.ctx.projects.put(next);
    this.ctx.emit({ type: 'project.changed', project: next });
    return next;
  }

  async remove(id: ProjectId): Promise<void> {
    const p = this.get(id);
    const workspaces = this.ctx.workspaces.listByProject(p.id);
    // 库里是级联删除；事件要一个个发，白板才知道哪些框没了
    this.ctx.tx(() => this.ctx.projects.remove(p.id));
    for (const w of workspaces) this.ctx.emit({ type: 'workspace.removed', id: w.id });
    this.ctx.emit({ type: 'project.removed', id: p.id });
  }

  async locate(id: ProjectId, folder: AbsPath): Promise<Project> {
    const p = this.get(id);
    let path = existingFolder(folder);
    let repos: RepoRef[] = [];
    if (p.kind === 'git') {
      const root = await this.ctx.git.repoRoot(path);
      if (!root) throw new AgentDeckError({ code: 'not-a-git-repo', message: `${basename(path)} isn’t a Git repository` });
      path = root;
      repos = p.repos.map((r) => ({ ...r, path: root }));
    } else if (p.kind === 'multi-repo') {
      for (const r of p.repos) {
        const sub = join(path, r.name);
        if ((await this.ctx.git.repoRoot(sub)) !== sub)
          throw new AgentDeckError({ code: 'not-found', message: `${r.name} isn’t a Git repository in ${basename(path)}` });
      }
      repos = p.repos.map((r) => ({ ...r, path: join(path, r.name) }));
    }
    const other = this.ctx.projects.findByPath(path);
    if (other && other.id !== p.id) throw invalid(`${other.name} already uses this folder`);

    const oldPath = p.path;
    const next: Project = { ...p, path, repos, missing: false };
    const moved = this.ctx.workspaces
      .listByProject(p.id)
      .filter((w) => w.mode === 'main-folder' && w.path === oldPath)
      .map((w) => mainFolderAt(w, next));
    this.ctx.tx(() => {
      this.ctx.projects.put(next);
      for (const w of moved) this.ctx.workspaces.put(w);
    });
    this.ctx.emit({ type: 'project.changed', project: next });
    for (const w of moved) this.ctx.emit({ type: 'workspace.changed', workspace: w });
    return next;
  }

  async initGit(id: ProjectId): Promise<Project> {
    const p = this.get(id);
    if (p.kind !== 'plain') throw invalid(`${p.name} is already a Git project`);
    if (!existsSync(p.path)) throw new AgentDeckError({ code: 'not-found', message: `Folder not found: ${p.path}` });
    await this.ctx.git.init(p.path);
    return this.becameGit(p);
  }

  // ---- 内部 ----

  private get(id: ProjectId): Project {
    const p = this.ctx.projects.get(id);
    if (!p) throw new AgentDeckError({ code: 'not-found', message: 'Project not found' });
    return p;
  }

  private async childRepos(dir: AbsPath): Promise<{ name: string; path: AbsPath }[]> {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    // 只看下一层，不往深处找
    const candidates = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .filter((e) => existsSync(join(dir, e.name, '.git')))
      .map((e) => ({ name: e.name, path: join(dir, e.name) }));
    const checked = await Promise.all(
      candidates.map(async (c) => ((await this.ctx.git.repoRoot(c.path)) === c.path ? c : null)),
    );
    return checked.filter((c): c is { name: string; path: AbsPath } => c !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async create(kind: Project['kind'], path: AbsPath, repos: { name: string; path: AbsPath }[]): Promise<Project> {
    const name = basename(path);
    const taken = new Set(this.ctx.projects.list().map((p) => p.worktreeRoot));
    const project: Project = {
      id: this.ctx.newId() as ProjectId,
      name,
      kind,
      path,
      repos: await Promise.all(repos.map(async (r) => ({ ...r, baseBranch: await this.ctx.git.defaultBranch(r.path) }))),
      worktreeRoot: unusedPath(join(this.ctx.homeDir, '.agentdeck', 'worktrees', folderName(name)), (p) => taken.has(p)),
      copyIntoWorktrees: [...DEFAULT_COPY_INTO_WORKTREES],
      setupCommand: null,
      missing: false,
      lastUsedAt: this.ctx.now(),
    };
    this.ctx.projects.put(project);
    this.ctx.emit({ type: 'project.changed', project });
    return project;
  }

  /** 文件夹丢了 / 回来了；普通文件夹被别的程序 git init 了。有变化才写库、发事件。 */
  private async refresh(p: Project): Promise<Project> {
    const missing = !existsSync(p.path) || p.repos.some((r) => !existsSync(r.path));
    if (missing !== p.missing) {
      const next = { ...p, missing };
      this.ctx.projects.put(next);
      this.ctx.emit({ type: 'project.changed', project: next });
      return next;
    }
    if (!missing && p.kind === 'plain' && (await this.ctx.git.repoRoot(p.path)) === p.path) return this.becameGit(p);
    return p;
  }

  /** plain → git：项目加上仓库，主目录工作区带上分支。 */
  private async becameGit(p: Project): Promise<Project> {
    const next: Project = {
      ...p,
      kind: 'git',
      repos: [{ name: '.', path: p.path, baseBranch: await this.ctx.git.defaultBranch(p.path) }],
      copyIntoWorktrees: p.copyIntoWorktrees.length ? p.copyIntoWorktrees : [...DEFAULT_COPY_INTO_WORKTREES],
    };
    const branch = (await this.ctx.git.status(p.path)).branch;
    const workspaces = this.ctx.workspaces
      .listByProject(p.id)
      .filter((w) => w.mode === 'main-folder')
      .map((w): Workspace => ({ ...w, branch, repos: [{ name: '.', path: p.path, branch }] }));
    this.ctx.tx(() => {
      this.ctx.projects.put(next);
      for (const w of workspaces) this.ctx.workspaces.put(w);
    });
    this.ctx.emit({ type: 'project.changed', project: next });
    for (const w of workspaces) this.ctx.emit({ type: 'workspace.changed', workspace: w });
    return next;
  }
}

function mainFolderAt(w: Workspace, p: Project): Workspace {
  const repos = w.repos.map((r) => ({ ...r, path: p.repos.find((pr) => pr.name === r.name)?.path ?? r.path }));
  return { ...w, path: p.path, repos, missing: false };
}

function invalid(message: string): AgentDeckError {
  return new AgentDeckError({ code: 'invalid-argument', message });
}

function notAllowed(as: string, kind: string): AgentDeckError {
  return invalid(`Can’t add a ${kind} folder as ${as}`);
}
