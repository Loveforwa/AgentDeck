// 源代码管理面板（任务 G2 G3 G4）。用法照 VS Code 的源代码管理；需求见设计画布「8 · 源代码管理面板」。
// 面板跟着聚焦的工作区（workspaceId 由白板传进来）；所有 git 操作走 window.agentdeck.git。

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AgentDeckErrorData, CommitInfo, Project, StashInfo, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { AgentDeckError } from '@agentdeck/contracts';
import { Button, type PopoverAnchor } from '@agentdeck/ui-kit';
import { BranchPicker } from './BranchPicker.tsx';
import { ChangeList, type ChangeActions } from './ChangeList.tsx';
import { DiffView, type DiffTarget } from './DiffView.tsx';
import { CommitAllDialog, DiscardDialog, ErrorDetail, NewBranchDialog, SwitchDialog } from './dialogs.tsx';
import { BranchIcon, CaretIcon, RefreshIcon } from './icons.tsx';
import {
  baseName,
  branchSummary,
  commitLabel,
  commitPlan,
  groupChanges,
  joinPath,
  multiCommitLabel,
  operationLabel,
  relativeTime,
  shortPath,
  splitCommits,
  type ChangeRow,
  type CommitPlan,
} from './model.ts';
import { toErrorData, useDirectory, useRepos, type RepoState, type ScmApi } from './useScm.ts';
import './scm.css';

const NONE: readonly string[] = [];

export interface ScmPanelProps {
  /** 聚焦的窗口所在的工作区；聚焦的是散放窗口时传 null。 */
  workspaceId: WorkspaceId | null;
  /** 单击被别的工作区占用的分支、或 Repository 区的一行：白板平移到那个框并聚焦它。 */
  onGoToWorkspace?: (workspaceId: WorkspaceId) => void;
  /**
   * 这个工作区目录里开着的终端（不管是在跑还是空闲），例如 ['claude', 'zsh']。
   * 只要有一个，切分支前就先确认（Q38：空闲的 agent 和 Shell 也在这个目录里，切走会改掉它们眼前的文件）。
   */
  openTerminals?: readonly string[];
  /** @deprecated 旧名字，等同于 openTerminals。 */
  runningAgents?: readonly string[];
  /** 默认 window.agentdeck。dev 页面和测试传假实现。 */
  api?: ScmApi;
}

const COMMIT_ALL_KEY = 'agentdeck.scm.commitAllConfirmed';

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    globalThis.localStorage?.setItem(key, '1');
  } catch {
    // 存不了就下次再问一次
  }
}

type DialogState =
  | { kind: 'discard'; repo: RepoState; rows: ChangeRow[]; label: string }
  | { kind: 'switch'; repo: RepoState; branch: string; carryRefused: boolean; error: AgentDeckErrorData | null }
  | { kind: 'new-branch'; repo: RepoState; error: AgentDeckErrorData | null }
  | { kind: 'commit-all'; count: number; run: () => void };

interface Picker {
  repo: RepoState;
  anchor: PopoverAnchor;
}

export function ScmPanel({ workspaceId, onGoToWorkspace, openTerminals, runningAgents, api: apiProp }: ScmPanelProps) {
  const terminalsHere = openTerminals ?? runningAgents ?? NONE;
  const api = apiProp ?? window.agentdeck;
  const dir = useDirectory(api);
  const workspace = workspaceId ? (dir.workspaces?.find((w) => w.id === workspaceId) ?? null) : null;
  const project = workspace ? (dir.projects.find((p) => p.id === workspace.projectId) ?? null) : null;
  const data = useRepos(api, workspace, project);

  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [opError, setOpError] = useState<{ title: string; error: AgentDeckErrorData } | null>(null);
  const [commitError, setCommitError] = useState<AgentDeckErrorData | null>(null);
  // 每个工作区各自的提交信息草稿
  const drafts = useRef(new Map<WorkspaceId, string>());
  const [message, setMessageState] = useState('');
  const [dismissedStashes, setDismissedStashes] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setDiff(null);
    setPicker(null);
    setDialog(null);
    setOpError(null);
    setCommitError(null);
    setMessageState(workspaceId ? (drafts.current.get(workspaceId) ?? '') : '');
  }, [workspaceId]);

  const setMessage = (m: string) => {
    setMessageState(m);
    if (workspaceId) drafts.current.set(workspaceId, m);
  };

  const run = useCallback(
    async (title: string, fn: () => Promise<unknown>): Promise<AgentDeckErrorData | null> => {
      setOpError(null);
      const err = await data.act(fn);
      if (err) setOpError({ title, error: err });
      return err;
    },
    [data],
  );

  // ---- 文件操作 ----

  const changeActions = (repo: RepoState): ChangeActions => ({
    stage: (rows) => void run('Couldn’t stage', () => api.git.stage(repo.path, rows.map((r) => r.file.path))),
    unstage: (rows) => void run('Couldn’t unstage', () => api.git.unstage(repo.path, rows.map((r) => r.file.path))),
    discard: (rows, label) => setDialog({ kind: 'discard', repo, rows, label }),
    openDiff: (row, group) => setDiff({ repo: repo.path, path: row.file.path, staged: group === 'staged' }),
    openFile: (row) => void api.app.openInEditor(joinPath(repo.path, row.file.path)),
  });

  // ---- 提交 ----

  const commit = (targets: { repo: RepoState; plan: CommitPlan }[]) => {
    const text = message.trim();
    if (text === '' || targets.length === 0 || data.busy) return;
    const go = async () => {
      setCommitError(null);
      const multi = (workspace?.repos.length ?? 0) > 1;
      const err = await data.act(async () => {
        for (const t of targets) {
          try {
            await api.git.commit(t.repo.path, message, { all: t.plan.all });
          } catch (e) {
            if (!multi) throw e;
            const d = toErrorData(e);
            throw new AgentDeckError({ ...d, message: `${t.repo.name}: ${d.message}` });
          }
        }
      });
      if (err) setCommitError(err);
      else setMessage('');
    };
    const allCount = targets.filter((t) => t.plan.all).reduce((n, t) => n + t.plan.count, 0);
    if (allCount > 0 && !readFlag(COMMIT_ALL_KEY)) {
      setDialog({
        kind: 'commit-all',
        count: allCount,
        run: () => {
          writeFlag(COMMIT_ALL_KEY);
          void go();
        },
      });
      return;
    }
    void go();
  };

  const plans = data.repos.map((r) => ({ repo: r, plan: commitPlan(r.status) })).filter((t): t is { repo: RepoState; plan: CommitPlan } => t.plan !== null);

  // ---- 分支 ----

  const beginSwitch = (repo: RepoState, branch: string) => {
    const changes = repo.status?.files.length ?? 0;
    if (changes === 0 && terminalsHere.length === 0) {
      void run(`Couldn’t switch to ${branch}`, () => api.git.switchBranch(repo.path, branch, 'carry'));
      return;
    }
    setDialog({ kind: 'switch', repo, branch, carryRefused: false, error: null });
  };

  const doSwitch = async (repo: RepoState, branch: string, strategy: 'carry' | 'stash') => {
    const err = await data.act(() => api.git.switchBranch(repo.path, branch, strategy));
    if (!err) {
      setDialog(null);
      return;
    }
    setDialog({ kind: 'switch', repo, branch, carryRefused: strategy === 'carry' && err.code === 'dirty-worktree', error: err });
  };

  const createBranch = async (repo: RepoState, name: string) => {
    const err = await data.act(() => api.git.createBranch(repo.path, name, { switchTo: true }));
    if (err) setDialog({ kind: 'new-branch', repo, error: err });
    else setDialog(null);
  };

  const restoreStash = (repo: RepoState, stash: StashInfo) =>
    void run('Couldn’t restore your stashed changes', () => api.git.applyStash(repo.path, stash.id, { drop: true }));

  // ---- 画面 ----

  let body;
  if (workspaceId === null) body = <Empty>This window isn’t in a workspace.</Empty>;
  else if (dir.workspaces === null) body = <Empty muted>Loading…</Empty>;
  else if (!workspace) body = <Empty>This workspace is no longer on the board.</Empty>;
  else if (workspace.missing || project?.missing)
    body = (
      <>
        <WorkspaceHeader workspace={workspace} project={project} />
        <Empty>
          Folder not found
          <span className="scm-muted scm-mono">{workspace.path}</span>
        </Empty>
      </>
    );
  else if (project?.kind === 'plain')
    body = (
      <>
        <WorkspaceHeader workspace={workspace} project={project} />
        <PlainFolder
          project={project}
          onInit={() =>
            void run('Couldn’t initialize the repository', async () => {
              await api.projects.initGit(project.id);
              await dir.reload();
            })
          }
          busy={data.busy}
          error={opError?.error ?? null}
        />
      </>
    );
  else if (diff) body = <DiffView api={api} target={diff} onBack={() => setDiff(null)} />;
  else {
    const multi = data.repos.length > 1 || (workspace.repos.length > 1 && data.repos.length === 0);
    const single = !multi ? data.repos[0] : undefined;
    body = (
      <>
        <WorkspaceHeader workspace={workspace} project={project} />
        {single && (
          <BranchRow
            repo={single}
            onOpen={(anchor) => setPicker({ repo: single, anchor })}
            stash={pendingStash(single, dismissedStashes)}
            onRestore={(s) => restoreStash(single, s)}
            onDismiss={(s) => setDismissedStashes((d) => new Set(d).add(stashKey(single, s)))}
          />
        )}
        <CommitBox
          message={message}
          onChange={setMessage}
          label={multi ? multiCommitLabel(data.repos.map((r) => r.status)) : commitLabel(single?.status ?? null)}
          placeholder={single?.status?.branch ? `Message (⌘↩ to commit on ${single.status.branch})` : 'Message (⌘↩ to commit)'}
          canCommit={plans.length > 0 && !data.busy}
          onCommit={() => commit(plans)}
          error={commitError}
        />
        {opError && (
          <div className="scm-section">
            <span className="scm-error-title">{opError.title}</span>
            <ErrorDetail error={opError.error} />
          </div>
        )}
        {data.repos.length === 0 && data.loading && <Empty muted>Loading…</Empty>}
        {multi
          ? data.repos.map((r) => (
              <RepoGroup
                key={r.path}
                repo={r}
                actions={changeActions(r)}
                busy={data.busy}
                stash={pendingStash(r, dismissedStashes)}
                onRestore={(s) => restoreStash(r, s)}
                onDismiss={(s) => setDismissedStashes((d) => new Set(d).add(stashKey(r, s)))}
                onOpenBranches={(anchor) => setPicker({ repo: r, anchor })}
                canCommit={message.trim() !== '' && commitPlan(r.status) !== null && !data.busy}
                onCommit={() => {
                  const plan = commitPlan(r.status);
                  if (plan) commit([{ repo: r, plan }]);
                }}
              />
            ))
          : single && (
              <>
                <RepoChanges repo={single} actions={changeActions(single)} busy={data.busy} />
                <RepositoryList repo={single} workspaces={dir.workspaces} current={workspace} onGoTo={onGoToWorkspace} />
                <CommitList commits={single.log} baseBranch={single.status?.baseBranch ?? single.baseBranch ?? null} />
              </>
            )}
      </>
    );
  }

  return (
    <aside className="scm" aria-label="Source Control" aria-busy={data.loading || undefined}>
      <div className="scm-top">
        <span className="scm-eyebrow">Source Control</span>
        {data.refreshing && <span className="scm-muted scm-refreshing">Refreshing…</span>}
        <Button
          variant="ghost"
          size="sm"
          className="scm-refresh"
          aria-label="Refresh"
          title="Refresh"
          disabled={!workspace || data.loading}
          onClick={() => {
            void data.refresh();
          }}
        >
          <RefreshIcon />
        </Button>
      </div>
      <div className="scm-body">{body}</div>

      {picker && (
        <BranchPicker
          api={api}
          anchor={picker.anchor}
          repoPath={picker.repo.path}
          workspaces={dir.workspaces ?? []}
          onClose={() => setPicker(null)}
          onPick={(b) => beginSwitch(picker.repo, b)}
          {...(onGoToWorkspace ? { onGoTo: onGoToWorkspace } : {})}
          onNewBranch={() => setDialog({ kind: 'new-branch', repo: picker.repo, error: null })}
        />
      )}
      {dialog?.kind === 'switch' && (
        <SwitchDialog
          branch={dialog.branch}
          current={dialog.repo.status?.branch ?? null}
          changes={data.repos.find((r) => r.path === dialog.repo.path)?.status?.files.length ?? 0}
          agents={terminalsHere}
          carryRefused={dialog.carryRefused}
          error={dialog.error}
          busy={data.busy}
          onCancel={() => setDialog(null)}
          onSwitch={(s) => void doSwitch(dialog.repo, dialog.branch, s)}
        />
      )}
      {dialog?.kind === 'discard' && (
        <DiscardDialog
          rows={dialog.rows}
          label={dialog.label}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const { repo, rows } = dialog;
            setDialog(null);
            void run('Couldn’t discard changes', () => api.git.discard(repo.path, rows.map((r) => r.file.path)));
          }}
        />
      )}
      {dialog?.kind === 'new-branch' && (
        <NewBranchDialog
          from={dialog.repo.status?.branch ?? null}
          error={dialog.error}
          busy={data.busy}
          onCancel={() => setDialog(null)}
          onCreate={(name) => void createBranch(dialog.repo, name)}
        />
      )}
      {dialog?.kind === 'commit-all' && (
        <CommitAllDialog
          count={dialog.count}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const go = dialog.run;
            setDialog(null);
            go();
          }}
        />
      )}
    </aside>
  );
}

// ---- 各块 ----

function Empty({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <div className={muted ? 'scm-empty scm-muted' : 'scm-empty'}>{children}</div>;
}

function useCopied(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(key);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1500);
  };
  return [copied, copy];
}

function WorkspaceHeader({ workspace, project }: { workspace: Workspace; project: Project | null }) {
  const [copied, copy] = useCopied();
  const repos = workspace.repos.length;
  return (
    <div className="scm-section scm-head">
      <span className="scm-head-name">
        {project && project.name !== workspace.name ? `${project.name} · ${workspace.name}` : workspace.name}
      </span>
      <button type="button" className="scm-path" title={`${workspace.path}\nClick to copy`} onClick={() => copy('path', workspace.path)}>
        <span className="scm-mono">{copied === 'path' ? 'Copied' : shortPath(workspace.path)}</span>
        {repos > 1 && <span className="scm-muted"> · {repos} repositories</span>}
      </button>
    </div>
  );
}

function BranchButton({ repo, onOpen, small }: { repo: RepoState; onOpen: (anchor: PopoverAnchor) => void; small?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const s = repo.status;
  const label = s ? (s.branch ?? `${s.head?.slice(0, 7) ?? 'HEAD'} (detached)`) : '…';
  return (
    <button
      ref={ref}
      type="button"
      className={small ? 'scm-branch scm-branch--small' : 'scm-branch'}
      aria-haspopup="dialog"
      aria-label={`Branch ${label}. Switch branch`}
      disabled={!s}
      onClick={() => onOpen(ref.current)}
    >
      <BranchIcon />
      <span className="scm-mono scm-branch-label">{label}</span>
      <CaretIcon />
    </button>
  );
}

function stashKey(repo: RepoState, s: StashInfo): string {
  return `${repo.path}\0${s.at}\0${s.message}`;
}

/** 切回存 stash 的那个分支时，提示恢复。 */
function pendingStash(repo: RepoState, dismissed: ReadonlySet<string>): StashInfo | null {
  const branch = repo.status?.branch;
  if (!branch) return null;
  return repo.stashes.find((s) => s.branch === branch && !dismissed.has(stashKey(repo, s))) ?? null;
}

function StashBanner({ stash, onRestore, onDismiss }: { stash: StashInfo; onRestore(): void; onDismiss(): void }) {
  return (
    <div className="scm-stash" role="status">
      <span>
        Changes stashed when you left {stash.branch} <span className="scm-muted">· {relativeTime(stash.at)}</span>
      </span>
      <span className="scm-stash-actions">
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
        <Button size="sm" onClick={onRestore}>
          Restore
        </Button>
      </span>
    </div>
  );
}

function BranchRow(props: {
  repo: RepoState;
  onOpen: (anchor: PopoverAnchor) => void;
  stash: StashInfo | null;
  onRestore(s: StashInfo): void;
  onDismiss(s: StashInfo): void;
}) {
  const { repo, onOpen, stash } = props;
  const s = repo.status;
  const op = s ? operationLabel(s.operation) : null;
  const summary = s ? branchSummary(s) : '';
  return (
    <div className="scm-section scm-branch-row">
      <div className="scm-branch-line">
        <BranchButton repo={repo} onOpen={onOpen} />
        {op && <span className="scm-badge">{op}</span>}
      </div>
      {summary && <span className="scm-muted scm-small">{summary}</span>}
      {repo.error && <ErrorDetail error={repo.error} />}
      {stash && <StashBanner stash={stash} onRestore={() => props.onRestore(stash)} onDismiss={() => props.onDismiss(stash)} />}
    </div>
  );
}

function CommitBox(props: {
  message: string;
  onChange(m: string): void;
  label: string;
  placeholder: string;
  canCommit: boolean;
  onCommit(): void;
  error: AgentDeckErrorData | null;
}) {
  const empty = props.message.trim() === '';
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!empty && props.canCommit) props.onCommit();
    }
  };
  return (
    <div className="scm-section scm-commit">
      <textarea
        className="scm-input scm-message-input"
        aria-label="Commit message"
        placeholder={props.placeholder}
        rows={2}
        value={props.message}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button variant="primary" className="scm-commit-button" disabled={empty || !props.canCommit} onClick={props.onCommit}>
        {props.label}
      </Button>
      {props.error && (
        <>
          <span className="scm-error-title">Commit failed</span>
          <ErrorDetail error={props.error} />
        </>
      )}
    </div>
  );
}

function RepoChanges({ repo, actions, busy }: { repo: RepoState; actions: ChangeActions; busy: boolean }) {
  if (!repo.status) return repo.error ? null : <Empty muted>Loading…</Empty>;
  const groups = groupChanges(repo.status.files);
  if (groups.length === 0) return <Empty muted>No changes</Empty>;
  return <ChangeList groups={groups} actions={actions} disabled={busy} />;
}

function RepoGroup(props: {
  repo: RepoState;
  actions: ChangeActions;
  busy: boolean;
  stash: StashInfo | null;
  onRestore(s: StashInfo): void;
  onDismiss(s: StashInfo): void;
  onOpenBranches(anchor: PopoverAnchor): void;
  canCommit: boolean;
  onCommit(): void;
}) {
  const { repo } = props;
  const s = repo.status;
  const op = s ? operationLabel(s.operation) : null;
  const summary = s ? branchSummary(s) : '';
  return (
    <section className="scm-repo" aria-label={repo.name}>
      <div className="scm-repo-head">
        <span className="scm-repo-name">{repo.name}</span>
        <BranchButton repo={repo} onOpen={props.onOpenBranches} small />
        {op && <span className="scm-badge">{op}</span>}
        <Button size="sm" variant="ghost" className="scm-repo-commit" disabled={!props.canCommit} onClick={props.onCommit}>
          Commit this repo
        </Button>
      </div>
      {summary && <span className="scm-muted scm-small scm-repo-summary">{summary}</span>}
      {repo.error && <ErrorDetail error={repo.error} />}
      {props.stash && (
        <StashBanner stash={props.stash} onRestore={() => props.onRestore(props.stash!)} onDismiss={() => props.onDismiss(props.stash!)} />
      )}
      <RepoChanges repo={repo} actions={props.actions} busy={props.busy} />
    </section>
  );
}

function RepositoryList(props: {
  repo: RepoState;
  workspaces: readonly Workspace[];
  current: Workspace;
  onGoTo: ((id: WorkspaceId) => void) | undefined;
}) {
  const { repo, workspaces, current, onGoTo } = props;
  if (repo.worktrees.length < 2) return null;
  return (
    <section className="scm-section scm-list" aria-label="Repository">
      <span className="scm-section-title">Repository</span>
      {repo.worktrees.map((wt) => {
        const ws = workspaces.find((w) => w.path === wt.path || w.repos.some((r) => r.path === wt.path)) ?? null;
        const here = ws?.id === current.id;
        const label = wt.branch ?? `${wt.head.slice(0, 7)} (detached)`;
        const where = wt.main ? 'main folder' : `…/${baseName(wt.path)}`;
        const canGo = !!ws && !here && !!onGoTo;
        return (
          <button
            key={wt.path}
            type="button"
            className="scm-list-row"
            data-current={here || undefined}
            data-off={!ws || undefined}
            disabled={!canGo}
            title={ws ? wt.path : `${wt.path}\nNot on the board`}
            onClick={() => ws && onGoTo?.(ws.id)}
          >
            <BranchIcon />
            <span className="scm-mono scm-list-main">{label}</span>
            <span className="scm-muted scm-list-note">{ws ? where : 'not on board'}</span>
          </button>
        );
      })}
    </section>
  );
}

function CommitList({ commits, baseBranch }: { commits: CommitInfo[]; baseBranch: string | null }) {
  const [copied, copy] = useCopied();
  if (commits.length === 0) return null;
  const { own, onBase } = splitCommits(commits);
  const row = (c: CommitInfo) => (
    <button key={c.hash} type="button" className="scm-list-row" title={`${c.subject}\n${c.author} · ${c.hash}\nClick to copy the hash`} onClick={() => copy(c.hash, c.hash)}>
      <span className="scm-mono scm-muted scm-hash">{c.shortHash}</span>
      <span className="scm-list-main">{copied === c.hash ? 'Copied' : c.subject}</span>
      <span className="scm-muted scm-list-note">{relativeTime(c.at)}</span>
    </button>
  );
  return (
    <section className="scm-section scm-list" aria-label="Commits">
      <span className="scm-section-title">Commits</span>
      {own.map(row)}
      {onBase.length > 0 && <div className="scm-on-base">On {baseBranch ?? 'base branch'}</div>}
      {onBase.map(row)}
    </section>
  );
}

function PlainFolder({ project, onInit, busy, error }: { project: Project; onInit(): void; busy: boolean; error: AgentDeckErrorData | null }) {
  return (
    <div className="scm-section scm-plain">
      <p className="scm-message">{project.name} isn’t a Git repository.</p>
      <p className="scm-message scm-muted">Initialize one to track changes, commit, and create workspaces on new branches.</p>
      <Button variant="primary" onClick={onInit} disabled={busy}>
        Initialize Repository
      </Button>
      {error && <ErrorDetail error={error} />}
    </div>
  );
}
