// 面板的数据：工作区和项目列表（靠事件保持最新），聚焦的工作区里每个仓库的 git 状态。
// git 只在三种时候刷新：聚焦的工作区变了、这个工作区的 agent 一轮结束、面板自己做完 git 操作；再加手动刷新。
// 不监听文件。服务推来的 git.status 直接用，不额外再查。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AbsPath,
  AgentDeckApi,
  AgentDeckErrorData,
  BranchInfo,
  CommitInfo,
  LogOptions,
  Project,
  RepoStatus,
  StashInfo,
  Workspace,
  WorkspaceId,
  WorktreeInfo,
} from '@agentdeck/contracts';
import { isAgentDeckErrorData } from '@agentdeck/contracts';

/** skills（N9 的 SKILLS · MCP 小节）可以不给：没有时小节写 “Not available here.”。 */
export type ScmApi = Pick<AgentDeckApi, 'git' | 'projects' | 'workspaces' | 'app' | 'on'> & Partial<Pick<AgentDeckApi, 'skills'>>;

/** 多仓库时每个仓库的提交列表最多几条（需求：最近 20 个）。 */
export const LOG_LIMIT = 20;
/** 提交图（N5，单仓库）最多几条。 */
export const GRAPH_LIMIT = 60;

/** 提交图看哪些分支：This workspace = HEAD 加基础分支；All branches = 所有本地分支。 */
export type GraphView = 'workspace' | 'all';
/** 刷新超过这么久显示 Refreshing…。 */
export const REFRESHING_AFTER_MS = 1000;

export interface RepoState {
  /** 单仓库是 '.'，多仓库是子文件夹名。 */
  name: string;
  path: AbsPath;
  baseBranch: string | undefined;
  status: RepoStatus | null;
  log: CommitInfo[];
  stashes: StashInfo[];
  /** 这个项目所有的工作目录（提交图里分支对上白板上的框），只在单仓库时取。 */
  worktrees: WorktreeInfo[];
  /** 本地分支，带 merged（相对基础分支），只在单仓库时取：提交图收起已合并的旧分支。 */
  branches: BranchInfo[];
  error: AgentDeckErrorData | null;
}

export function toErrorData(e: unknown): AgentDeckErrorData {
  if (isAgentDeckErrorData(e)) {
    const d = e as AgentDeckErrorData;
    return d.detail === undefined ? { code: d.code, message: d.message } : { code: d.code, message: d.message, detail: d.detail };
  }
  return { code: 'internal', message: e instanceof Error ? e.message : String(e) };
}

/** 工作区和项目。启动时取一次，之后跟着 workspace.* / project.* 事件改。 */
export function useDirectory(api: ScmApi) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  const reload = useCallback(async () => {
    const [w, p] = await Promise.all([api.workspaces.list(), api.projects.list()]);
    setWorkspaces(w);
    setProjects(p);
  }, [api]);

  useEffect(() => {
    let live = true;
    void Promise.all([api.workspaces.list(), api.projects.list()]).then(([w, p]) => {
      if (!live) return;
      setWorkspaces(w);
      setProjects(p);
    });
    const offs = [
      api.on('workspace.changed', ({ workspace }) =>
        setWorkspaces((list) => upsert(list ?? [], workspace, (x) => x.id === workspace.id)),
      ),
      api.on('workspace.removed', ({ id }) => setWorkspaces((list) => (list ?? []).filter((x) => x.id !== id))),
      api.on('project.changed', ({ project }) => setProjects((list) => upsert(list, project, (x) => x.id === project.id))),
      api.on('project.removed', ({ id }) => setProjects((list) => list.filter((x) => x.id !== id))),
    ];
    return () => {
      live = false;
      for (const off of offs) off();
    };
  }, [api]);

  return { workspaces, projects, reload };
}

function upsert<T>(list: T[], item: T, same: (x: T) => boolean): T[] {
  return list.some(same) ? list.map((x) => (same(x) ? item : x)) : [...list, item];
}

/** 单仓库取提交图（N5），多仓库照旧取最近几条。 */
function fetchLog(api: ScmApi, path: AbsPath, baseBranch: string | undefined, single: boolean, view: GraphView): Promise<CommitInfo[]> {
  const opts: LogOptions = baseBranch === undefined ? {} : { baseBranch };
  if (!single) return api.git.log(path, LOG_LIMIT, opts);
  return api.git.log(path, GRAPH_LIMIT, { ...opts, graph: view === 'all' ? {} : { branches: [] } });
}

/** 聚焦的工作区里每个仓库的 git 状态，以及刷新和操作。view：提交图看哪些分支，换了只重取提交图。 */
export function useRepos(api: ScmApi, workspace: Workspace | null, project: Project | null, view: GraphView = 'all') {
  const [repos, setRepos] = useState<RepoState[]>([]);
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  /** 服务说某个仓库刷新超过 1 秒了（git.refreshing），等到它的 git.status 为止。 */
  const [remoteRefreshing, setRemoteRefreshing] = useState<ReadonlySet<AbsPath>>(new Set());
  const [busy, setBusy] = useState(0);
  const generation = useRef(0);

  const targets = useMemo(() => {
    if (!workspace || !project || project.kind === 'plain' || workspace.missing) return [];
    // 刚 Initialize Repository 的主目录工作区，服务可能还没把仓库记进 repos：用工作区目录本身
    const repos = workspace.repos.length === 0 && workspace.mode === 'main-folder' ? [{ name: '.', path: workspace.path }] : workspace.repos;
    return repos.map((r) => ({
      name: r.name,
      path: r.path,
      baseBranch: project.repos.find((pr) => pr.name === r.name)?.baseBranch,
      mainPath: project.repos.find((pr) => pr.name === r.name)?.path ?? r.path,
    }));
  }, [workspace, project]);
  const targetKey = targets.map((t) => `${t.name}\0${t.path}\0${t.baseBranch ?? ''}`).join('\n');
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const viewRef = useRef(view);
  viewRef.current = view;

  const refresh = useCallback(async () => {
    const list = targetsRef.current;
    if (list.length === 0) {
      // 没有仓库（散放窗口、普通文件夹）：不动 generation，免得把刚发出的有效刷新作废
      setRepos([]);
      setLoading(false);
      setSlow(false);
      return;
    }
    const gen = ++generation.current;
    setLoading(true);
    const timer = setTimeout(() => {
      if (generation.current === gen) setSlow(true);
    }, REFRESHING_AFTER_MS);
    try {
      const single = list.length === 1;
      const next = await Promise.all(
        list.map(async (t): Promise<RepoState> => {
          const opts = t.baseBranch === undefined ? {} : { baseBranch: t.baseBranch };
          const statusP = api.git.status(t.path, opts);
          const [status, log, stashes, worktrees, branches] = await Promise.allSettled([
            statusP,
            fetchLog(api, t.path, t.baseBranch, single, viewRef.current),
            api.git.stashes(t.path),
            single ? api.git.worktrees(t.mainPath) : Promise.resolve([]),
            // 已合并的分支要知道基础分支：项目没设就等 status 告诉我们
            single
              ? statusP.then((s) => {
                  const into = t.baseBranch ?? s.baseBranch;
                  return api.git.branches(t.path, into ? { mergedInto: into } : {});
                })
              : Promise.resolve([]),
          ]);
          return {
            name: t.name,
            path: t.path,
            baseBranch: t.baseBranch,
            status: status.status === 'fulfilled' ? status.value : null,
            log: log.status === 'fulfilled' ? log.value : [],
            stashes: stashes.status === 'fulfilled' ? stashes.value : [],
            worktrees: worktrees.status === 'fulfilled' ? worktrees.value : [],
            branches: branches.status === 'fulfilled' ? branches.value : [],
            error: status.status === 'rejected' ? toErrorData(status.reason) : null,
          };
        }),
      );
      if (generation.current === gen) setRepos(next);
    } finally {
      clearTimeout(timer);
      if (generation.current === gen) {
        setLoading(false);
        setSlow(false);
      }
    }
  }, [api]);

  // 触发 1：聚焦的工作区变了（或者它的仓库变了，比如 Initialize Repository 之后）
  useEffect(() => {
    // 换了工作区：还在路上的旧结果作废
    generation.current += 1;
    setRepos((prev) => (prev.length && prev.every((r) => targetsRef.current.some((t) => t.path === r.path)) ? prev : []));
    void refresh();
  }, [targetKey, refresh]);

  // 触发 2：这个工作区里的 agent 一轮结束
  const workspaceId: WorkspaceId | null = workspace?.id ?? null;
  useEffect(() => {
    if (!workspaceId) return;
    return api.on('agent.turn-end', (e) => {
      if (e.workspaceId === workspaceId) void refresh();
    });
  }, [api, workspaceId, refresh]);

  // 提交图换了视图（This workspace / All branches）：只重取提交图，不算一次刷新
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    const list = targetsRef.current;
    const t = list[0];
    if (list.length !== 1 || !t) return;
    let live = true;
    void fetchLog(api, t.path, t.baseBranch, true, view).then(
      (log) => {
        if (live) setRepos((rs) => rs.map((r) => (r.path === t.path ? { ...r, log } : r)));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, view]);

  // 服务推来的状态：直接换上，不算一次刷新
  useEffect(() => {
    const offStatus = api.on('git.status', ({ status }) => {
      setRepos((list) => (list.some((r) => r.path === status.repo) ? list.map((r) => (r.path === status.repo ? { ...r, status, error: null } : r)) : list));
      setRemoteRefreshing((s) => (s.has(status.repo) ? without(s, status.repo) : s));
    });
    const offRefreshing = api.on('git.refreshing', ({ repo }) => {
      if (targetsRef.current.some((t) => t.path === repo)) setRemoteRefreshing((s) => new Set(s).add(repo));
    });
    return () => {
      offStatus();
      offRefreshing();
    };
  }, [api]);

  /** 触发 3：面板自己的 git 操作。做完（成功或失败）都刷新一次；失败时返回错误。 */
  const act = useCallback(
    async (fn: () => Promise<unknown>): Promise<AgentDeckErrorData | null> => {
      setBusy((n) => n + 1);
      try {
        await fn();
        return null;
      } catch (e) {
        return toErrorData(e);
      } finally {
        setBusy((n) => n - 1);
        await refresh();
      }
    },
    [refresh],
  );

  const refreshing = slow || targets.some((t) => remoteRefreshing.has(t.path));
  return { repos, loading, refreshing, busy: busy > 0, refresh, act };
}

function without<T>(s: ReadonlySet<T>, v: T): Set<T> {
  const n = new Set(s);
  n.delete(v);
  return n;
}
