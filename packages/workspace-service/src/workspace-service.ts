// WorkspaceService：新建、改名、删除工作区。需求见「4 · 工作区框」「8 · 源代码管理面板」的多仓库规则。
// 新建 worktree：每个仓库一个，同一个分支名；任何一个失败，已经建好的 worktree 和新分支全部撤销。

import { cpSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AbsPath,
  CreateWorkspaceRequest,
  CreateWorkspaceResult,
  Project,
  RemoveWorkspaceRequest,
  RepoRef,
  RepoStatus,
  Workspace,
  WorkspaceId,
  WorkspaceRepo,
  WorkspaceService,
} from '@agentdeck/contracts';
import { AgentDeckError } from '@agentdeck/contracts';
import type { Context } from './context.ts';
import { branchSlug, safeRelative, unusedPath } from './paths.ts';

interface Created {
  repo: RepoRef;
  path: AbsPath;
  createdBranch: boolean;
}

export class LocalWorkspaceService implements WorkspaceService {
  constructor(private readonly ctx: Context) {}

  async create(req: CreateWorkspaceRequest): Promise<CreateWorkspaceResult> {
    const project = this.ctx.projects.get(req.projectId);
    if (!project) throw new AgentDeckError({ code: 'not-found', message: 'Project not found' });
    if (project.missing || !existsSync(project.path))
      throw new AgentDeckError({ code: 'not-found', message: `Folder not found: ${project.path}` });
    const repos = selectRepos(project, req.repos);
    const workspace = req.mode === 'main-folder' ? await this.mainFolder(project, repos, req) : await this.worktree(project, repos, req);

    const at = this.ctx.now();
    this.ctx.tx(() => {
      this.ctx.workspaces.put(workspace);
      this.ctx.projects.touch(project.id, at);
    });
    this.ctx.emit({ type: 'workspace.changed', workspace });
    const setup =
      req.mode === 'worktree' && project.setupCommand ? { command: project.setupCommand, cwd: workspace.path } : null;
    return { workspace, setup };
  }

  async list(): Promise<Workspace[]> {
    const out: Workspace[] = [];
    for (const w of this.ctx.workspaces.list()) out.push(await this.refresh(w));
    return out;
  }

  async rename(id: WorkspaceId, name: string): Promise<Workspace> {
    const w = this.get(id);
    if (name.trim() === '') throw invalid('Workspace name is empty');
    const next = { ...w, name: name.trim() };
    this.ctx.workspaces.put(next);
    this.ctx.emit({ type: 'workspace.changed', workspace: next });
    return next;
  }

  async remove(req: RemoveWorkspaceRequest): Promise<void> {
    const w = this.get(req.id);
    if (req.deleteFolder) {
      if (w.mode === 'main-folder') throw invalid('The main folder can’t be deleted, only removed from the board');
      const project = this.ctx.projects.get(w.projectId);
      if (!project) throw new AgentDeckError({ code: 'not-found', message: 'Project not found' });
      const force = req.force ?? false;
      if (!force) await this.assertClean(w);
      for (const r of w.repos) {
        const main = project.repos.find((pr) => pr.name === r.name);
        if (!main) continue;
        await this.ctx.git.removeWorktree(main.path, r.path, { force });
      }
      // 多仓库的父目录：里面的 worktree 都删了，空了就删掉
      if (project.kind === 'multi-repo') removeIfEmpty(w.path);
    }
    this.ctx.workspaces.remove(w.id);
    this.ctx.emit({ type: 'workspace.removed', id: w.id });
  }

  /**
   * 不在 contracts 里：组装时把 git.status 事件接过来，面板里切了分支，框的标题跟着变。
   * 有变化时写库、发 workspace.changed，返回变了的工作区。
   */
  noteStatus(status: RepoStatus): Workspace[] {
    const changed: Workspace[] = [];
    for (const w of this.ctx.workspaces.list()) {
      if (!w.repos.some((r) => r.path === status.repo && r.branch !== status.branch)) continue;
      const next = withRepoBranches(w, new Map([[status.repo, status.branch]]));
      this.ctx.workspaces.put(next);
      this.ctx.emit({ type: 'workspace.changed', workspace: next });
      changed.push(next);
    }
    return changed;
  }

  // ---- 新建 ----

  private async mainFolder(project: Project, repos: RepoRef[], req: CreateWorkspaceRequest): Promise<Workspace> {
    if (req.branch) throw invalid('A main-folder workspace uses the branch that’s checked out; don’t pass one');
    if (this.ctx.workspaces.listByProject(project.id).some((w) => w.mode === 'main-folder'))
      throw invalid(`${project.name}’s main folder is already on the board`);
    const wsRepos: WorkspaceRepo[] = await Promise.all(
      repos.map(async (r) => ({ name: r.name, path: r.path, branch: (await this.ctx.git.status(r.path)).branch })),
    );
    return {
      id: this.ctx.newId() as WorkspaceId,
      projectId: project.id,
      name: req.name?.trim() || project.name,
      mode: 'main-folder',
      path: project.path,
      branch: commonBranch(wsRepos),
      repos: wsRepos,
      createdAt: this.ctx.now(),
      missing: false,
    };
  }

  private async worktree(project: Project, repos: RepoRef[], req: CreateWorkspaceRequest): Promise<Workspace> {
    if (project.kind === 'plain') throw invalid(`${project.name} has no Git, so it only has a main-folder workspace`);
    const choice = req.branch;
    if (!choice || choice.name.trim() === '') throw invalid('Choose a branch for the new worktree');
    const branch = choice.name.trim();
    const multi = project.kind === 'multi-repo';
    const label = (r: RepoRef): string => (multi ? ` in ${r.name}` : '');

    // 先全部检查一遍，能提前发现的问题不用建了再回滚
    for (const r of repos) {
      const list = await this.ctx.git.branches(r.path);
      const b = list.find((x) => x.name === branch);
      if (choice.kind === 'new' && b)
        throw new AgentDeckError({ code: 'branch-exists', message: `Branch ${branch} already exists${label(r)}` });
      if (choice.kind === 'existing' && !b)
        throw new AgentDeckError({ code: 'not-found', message: `Branch ${branch} not found${label(r)}` });
      if (choice.kind === 'existing' && b?.checkedOutAt)
        throw new AgentDeckError({ code: 'branch-in-use', message: `Branch ${branch} is checked out in ${b.checkedOutAt}` });
    }

    const taken = new Set(this.ctx.workspaces.list().map((w) => w.path));
    const path = unusedPath(join(project.worktreeRoot, branchSlug(branch)), (p) => taken.has(p));
    const created: Created[] = [];
    try {
      mkdirSync(multi ? path : dirname(path), { recursive: true });
      for (const r of repos) {
        const wt = multi ? join(path, r.name) : path;
        this.progress(project, 'worktree', branch, r, `Creating worktree${label(r)}…`);
        const from = choice.kind === 'new' ? (choice.from ?? r.baseBranch) : undefined;
        try {
          await this.ctx.git.addWorktree(
            r.path,
            wt,
            from === undefined ? { name: branch, create: false } : { name: branch, create: true, from },
          );
        } catch (e) {
          throw multi && e instanceof AgentDeckError ? prefixed(e, r.name) : e;
        }
        created.push({ repo: r, path: wt, createdBranch: choice.kind === 'new' });
      }
      for (const c of created) this.copyFiles(project, branch, c);
    } catch (e) {
      await this.rollback(created, branch);
      if (multi) rmSync(path, { recursive: true, force: true });
      throw e;
    }
    this.progress(project, 'done', branch, null, 'Worktree ready');
    return {
      id: this.ctx.newId() as WorkspaceId,
      projectId: project.id,
      name: req.name?.trim() || branch,
      mode: 'worktree',
      path,
      branch,
      repos: created.map((c) => ({ name: c.repo.name, path: c.path, branch })),
      createdAt: this.ctx.now(),
      missing: false,
    };
  }

  private copyFiles(project: Project, branch: string, c: Created): void {
    const copied: string[] = [];
    for (const entry of project.copyIntoWorktrees) {
      const rel = safeRelative(entry);
      if (!rel) continue;
      const src = join(c.repo.path, rel);
      const dst = join(c.path, rel);
      // 已经在 worktree 里的（被 git 跟踪的文件）不覆盖
      if (!existsSync(src) || existsSync(dst)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true, errorOnExist: false, force: false });
      copied.push(rel);
    }
    if (copied.length) this.progress(project, 'copy-files', branch, c.repo, `Copied ${copied.join(', ')}`);
  }

  private async rollback(created: Created[], branch: string): Promise<void> {
    for (const c of [...created].reverse()) {
      await this.ctx.git.removeWorktree(c.repo.path, c.path, { force: true }).catch(() => undefined);
      if (c.createdBranch) await this.ctx.git.deleteBranch(c.repo.path, branch, { force: true }).catch(() => undefined);
    }
  }

  private progress(
    project: Project,
    step: 'worktree' | 'copy-files' | 'done',
    branch: string,
    repo: RepoRef | null,
    message: string,
  ): void {
    this.ctx.emit({
      type: 'workspace.progress',
      projectId: project.id,
      step,
      branch,
      ...(repo && project.kind === 'multi-repo' ? { repo: repo.name } : {}),
      message,
    });
  }

  // ---- 其他 ----

  private get(id: WorkspaceId): Workspace {
    const w = this.ctx.workspaces.get(id);
    if (!w) throw new AgentDeckError({ code: 'not-found', message: 'Workspace not found' });
    return w;
  }

  private async assertClean(w: Workspace): Promise<void> {
    const dirty: string[] = [];
    for (const r of w.repos) {
      if (!existsSync(r.path)) continue;
      const files = (await this.ctx.git.status(r.path)).files;
      for (const f of files) dirty.push(w.repos.length > 1 ? `${r.name}/${f.path}` : f.path);
    }
    if (dirty.length)
      throw new AgentDeckError({
        code: 'dirty-worktree',
        message: `${dirty.length} uncommitted ${dirty.length === 1 ? 'change' : 'changes'} will be lost`,
        detail: dirty.join('\n'),
      });
  }

  /** 文件夹在不在；分支在别处被切换了（终端里 git switch）。有变化才写库、发事件。 */
  private async refresh(w: Workspace): Promise<Workspace> {
    const missing = !existsSync(w.path);
    let next = w;
    if (missing !== w.missing) next = { ...w, missing };
    if (!missing) {
      const branches = new Map<AbsPath, string | null>();
      for (const r of w.repos) {
        if (r.branch === null || !existsSync(r.path)) continue;
        const current = (await this.ctx.git.branches(r.path).catch(() => [])).find((b) => b.current);
        if (current && current.name !== r.branch) branches.set(r.path, current.name);
      }
      if (branches.size) next = withRepoBranches(next, branches);
    }
    if (next !== w) {
      this.ctx.workspaces.put(next);
      this.ctx.emit({ type: 'workspace.changed', workspace: next });
    }
    return next;
  }
}

function selectRepos(project: Project, names: string[] | undefined): RepoRef[] {
  if (names === undefined) return project.repos;
  if (project.kind !== 'multi-repo') throw invalid('Only multi-repo projects can pick repositories');
  const unknown = names.filter((n) => !project.repos.some((r) => r.name === n));
  if (unknown.length) throw invalid(`${project.name} has no repository named ${unknown.join(', ')}`);
  const picked = project.repos.filter((r) => names.includes(r.name));
  if (picked.length === 0) throw invalid('Pick at least one repository');
  return picked;
}

function commonBranch(repos: WorkspaceRepo[]): string | null {
  const first = repos[0]?.branch ?? null;
  return repos.every((r) => r.branch === first) ? first : null;
}

function withRepoBranches(w: Workspace, branches: Map<AbsPath, string | null>): Workspace {
  const repos = w.repos.map((r) => (branches.has(r.path) ? { ...r, branch: branches.get(r.path) ?? null } : r));
  return { ...w, repos, branch: commonBranch(repos) };
}

function removeIfEmpty(dir: AbsPath): void {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // 删不掉就留着，不影响结果
  }
}

function prefixed(e: AgentDeckError, repo: string): AgentDeckError {
  const data = e.toData();
  return new AgentDeckError({ ...data, message: `${repo}: ${data.message}` });
}

function invalid(message: string): AgentDeckError {
  return new AgentDeckError({ code: 'invalid-argument', message });
}
