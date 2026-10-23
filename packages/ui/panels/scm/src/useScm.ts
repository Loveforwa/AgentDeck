// 面板的数据：工作区和项目列表（靠事件保持最新），聚焦的工作区里每个仓库的 git 状态。
// git 只在三种时候刷新：聚焦的工作区变了、这个工作区的 agent 一轮结束、面板自己做完 git 操作；再加手动刷新。
// 不监听文件。服务推来的 git.status 直接用，不额外再查。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AbsPath,
  AgentDeckApi,
  AgentDeckErrorData,
  CommitInfo,
  Project,
  RepoStatus,
  StashInfo,
  Workspace,
  WorkspaceId,
  WorktreeInfo,
} from '@agentdeck/contracts';
import { isAgentDeckErrorData } from '@agentdeck/contracts';

export type ScmApi = Pick<AgentDeckApi, 'git' | 'projects' | 'workspaces' | 'app' | 'on'>;

/** 提交列表最多几条（需求：最近 20 个）。 */
export const LOG_LIMIT = 20;
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
  /** 这个项目所有的工作目录（Repository 区），只在单仓库时取。 */
  worktrees: WorktreeInfo[];
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

/** 聚焦的工作区里每个仓库的 git 状态，以及刷新和操作。 */
export function useRepos(api: ScmApi, workspace: Workspace | null, project: Project | null) {
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
          const [status, log, stashes, worktrees] = await Promise.allSettled([
            api.git.status(t.path, opts),
            api.git.log(t.path, LOG_LIMIT, opts),
            api.git.stashes(t.path),
            single ? api.git.worktrees(t.mainPath) : Promise.resolve([]),
          ]);
          return {
            name: t.name,
            path: t.path,
            baseBranch: t.baseBranch,
            status: status.status === 'fulfilled' ? status.value : null,
            log: log.status === 'fulfilled' ? log.value : [],
            stashes: stashes.status === 'fulfilled' ? stashes.value : [],
            worktrees: worktrees.status === 'fulfilled' ? worktrees.value : [],
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
