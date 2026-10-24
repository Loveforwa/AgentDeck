// 提交图（N5，IS-58）：替换原来的 Repository 分支列表和 Commits 列表。需求见设计画布「MVP v2 · v3」的“N5 · 面板里的提交图”。
// 泳道、分叉和合并的弧线、分支标签；白板上有框在用的分支带 ◧ 和框名；已合并、不在白板上的旧分支收成最后一行。
// 单击一行在下面展开这个提交改了哪些文件；悬停出现 Checkout（提交是某个分支的顶端时）和 Copy。
// 颜色只有墨黑和几种暖灰，在 scm.css 里用 token 定。

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { CommitFile, CommitInfo, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { Menu, Popover } from '@agentdeck/ui-kit';
import { BranchIcon, CaretIcon, ChevronIcon } from './icons.tsx';
import {
  LANE_W,
  ROW_H,
  collapsedBranches,
  framesByBranch,
  labelsFor,
  laneX,
  layoutGraph,
  linePath,
  strongTips,
  type GraphContext,
  type GraphLabel,
  type GraphRow,
} from './graph.ts';
import { KIND_LABEL, baseName, relativeTime } from './model.ts';
import { toErrorData, type GraphView, type RepoState, type ScmApi } from './useScm.ts';

const VIEW_LABEL: Record<GraphView, string> = { workspace: 'This workspace', all: 'All branches' };
/** 泳道再多也只画这么宽，多出来的被裁掉（文字不被挤没）。 */
const MAX_LANES = 6;
/** 展开的文件列表最多列几个。 */
const MAX_FILES = 40;

const LETTER: Record<CommitFile['kind'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  unmodified: 'M',
  ignored: 'M',
};

type Files = { state: 'loading' } | { state: 'ready'; files: CommitFile[] } | { state: 'error'; message: string };

export interface CommitGraphProps {
  api: ScmApi;
  repo: RepoState;
  workspaces: readonly Workspace[];
  view: GraphView;
  onView(view: GraphView): void;
  /** 单击带 ◧ 的标签：跳到那个框。 */
  onGoTo: ((id: WorkspaceId) => void) | undefined;
  /** 悬停的 Checkout：切到这个分支（走面板原来的切分支流程，有改动或终端时先问）。 */
  onCheckout(branch: string): void;
  busy: boolean;
}

export function CommitGraph({ api, repo, workspaces, view, onView, onGoTo, onCheckout, busy }: CommitGraphProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [files, setFiles] = useState<ReadonlyMap<string, Files>>(new Map());
  const [showMerged, setShowMerged] = useState(false);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const viewButton = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  // 换了仓库：展开的行和取到的文件都作废
  useEffect(() => {
    setOpen(null);
    setFiles(new Map());
  }, [repo.path]);

  const status = repo.status;
  const ctx: GraphContext = {
    worktrees: repo.worktrees,
    workspaces,
    branches: repo.branches,
    current: status?.branch ?? null,
    base: status?.baseBranch ?? repo.baseBranch ?? null,
  };
  const collapsed = collapsedBranches(ctx);
  const hidden = new Set(showMerged ? [] : collapsed);
  const layout = useMemo(
    () => layoutGraph(repo.log, strongTips(repo.log, status?.head ?? null, ctx.base)),
    [repo.log, status?.head, ctx.base],
  );
  const frames = framesByBranch(repo.worktrees, workspaces);
  const anyRefs = repo.log.some((c) => c.refs !== undefined);
  const lanes = Math.min(Math.max(layout.width, 1), MAX_LANES);
  const graphW = lanes * LANE_W + 4;

  const copy = (hash: string) => {
    void navigator.clipboard?.writeText(hash).catch(() => undefined);
    setCopied(hash);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  };

  const toggle = (c: CommitInfo) => {
    if (open === c.hash) {
      setOpen(null);
      return;
    }
    setOpen(c.hash);
    if (files.has(c.hash)) return;
    setFiles((m) => new Map(m).set(c.hash, { state: 'loading' }));
    api.git.log(repo.path, 1, { commit: c.hash }).then(
      (list) => {
        const found = list.find((x) => x.hash === c.hash)?.files;
        setFiles((m) =>
          new Map(m).set(c.hash, found ? { state: 'ready', files: found } : { state: 'error', message: 'Files aren’t available for this commit.' }),
        );
      },
      (e: unknown) => setFiles((m) => new Map(m).set(c.hash, { state: 'error', message: toErrorData(e).message })),
    );
  };

  if (repo.log.length === 0 && collapsed.length === 0) return null;

  return (
    <section className="scm-section scm-graph" aria-label="Commit graph" style={{ '--graph-w': `${graphW}px` } as CSSProperties}>
      <div className="scm-graph-head">
        <span className="scm-section-title">Graph</span>
        <button
          ref={viewButton}
          type="button"
          className="scm-graph-view"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label={`Show: ${VIEW_LABEL[view]}`}
          onClick={() => setMenu((m) => !m)}
        >
          {VIEW_LABEL[view]}
          <CaretIcon />
        </button>
      </div>
      <Popover open={menu} anchor={viewButton} placement="bottom-end" chrome={false} autoFocus={false} onClose={() => setMenu(false)}>
        <Menu
          aria-label="Graph view"
          defaultActive={view}
          onClose={() => setMenu(false)}
          items={(['workspace', 'all'] as const).map((v) => ({ id: v, label: VIEW_LABEL[v], checked: v === view, onSelect: () => onView(v) }))}
        />
      </Popover>

      <div role="list" className="scm-graph-rows">
        {layout.rows.map((row) => {
          const c = row.commit;
          const labels = labelsFor(c, { ...ctx, head: status?.head ?? null, hidden, anyRefs });
          const isHead = status?.head === c.hash;
          const target = checkoutTarget(labels, frames, ctx.current);
          const expanded = open === c.hash;
          return (
            <div key={c.hash} role="listitem" className="scm-graph-item">
              <div className="scm-graph-row" data-open={expanded || undefined}>
                <GraphCell row={row} width={graphW} head={isHead} />
                <button
                  type="button"
                  className="scm-graph-main"
                  aria-expanded={expanded}
                  title={`${c.subject}\n${c.author} · ${c.shortHash}`}
                  onClick={() => toggle(c)}
                >
                  <span className="scm-mono scm-muted scm-hash">{c.shortHash}</span>
                  <span className="scm-graph-subject">{copied === c.hash ? 'Copied' : c.subject}</span>
                </button>
                {labels.length > 0 && (
                  <span className="scm-graph-labels">
                    {labels.map((l) => (
                      <Label key={`${l.kind}:${l.name}`} label={l} onGoTo={onGoTo} />
                    ))}
                  </span>
                )}
                <span className="scm-muted scm-graph-time">{relativeTime(c.at)}</span>
                <span className="scm-graph-actions">
                  {target && (
                    <button
                      type="button"
                      className="scm-graph-action"
                      disabled={busy}
                      aria-label={`Checkout ${target}`}
                      title={`Switch this workspace to ${target}`}
                      onClick={() => onCheckout(target)}
                    >
                      Checkout
                    </button>
                  )}
                  <button type="button" className="scm-graph-action" aria-label={`Copy hash ${c.shortHash}`} title={c.hash} onClick={() => copy(c.hash)}>
                    Copy
                  </button>
                </span>
              </div>
              {expanded && <CommitFiles row={row} width={graphW} commit={c} files={files.get(c.hash) ?? { state: 'loading' }} />}
            </div>
          );
        })}
      </div>

      {collapsed.length > 0 && (
        <div className="scm-graph-merged">
          <button type="button" className="scm-graph-merged-toggle" aria-expanded={showMerged} onClick={() => setShowMerged((s) => !s)}>
            <ChevronIcon open={showMerged} />
            <span className="scm-graph-subject">
              {collapsed.length === 1 ? '1 merged branch' : `${collapsed.length} merged branches`} not on the board
            </span>
            <span className="scm-graph-merged-action">{showMerged ? 'Hide' : 'Show'}</span>
          </button>
          {showMerged && (
            <div role="list" aria-label="Merged branches">
              {collapsed.map((name) => (
                <div key={name} role="listitem" className="scm-graph-merged-row" title={frames.has(name) ? `${name}\nChecked out in a folder that isn’t on the board` : name}>
                  <BranchIcon />
                  <span className="scm-mono scm-graph-subject">{name}</span>
                  {frames.has(name) && <span className="scm-muted scm-graph-time">not on board</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 悬停 Checkout 切到哪个分支：这一行上的本地分支，不是当前分支、没被别的目录检出（被检出的用标签跳过去）。 */
function checkoutTarget(labels: readonly GraphLabel[], frames: ReadonlyMap<string, Workspace | null>, current: string | null): string | null {
  return labels.find((l) => l.kind === 'branch' && !l.current && l.name !== current && !frames.has(l.name))?.name ?? null;
}

/** 框名跟分支名一样（新建工作区默认这样）时只写 ◧，不重复。 */
function frameText(frame: Workspace, branch: string): string {
  if (frame.mode === 'main-folder') return '◧ main folder';
  return frame.name === branch ? '◧' : `◧ ${frame.name}`;
}

function Label({ label, onGoTo }: { label: GraphLabel; onGoTo: ((id: WorkspaceId) => void) | undefined }) {
  const text = label.kind === 'head' ? 'HEAD' : label.current ? `HEAD → ${label.name}` : label.name;
  const frame = label.frame;
  const common = {
    className: 'scm-graph-label',
    'data-kind': label.kind,
    'data-current': label.current || undefined,
    'data-board': frame ? true : undefined,
    'data-off': label.offBoard || undefined,
  };
  const body = (
    <>
      <span className="scm-mono scm-graph-label-name">{text}</span>
      {frame && <span className="scm-graph-frame">{frameText(frame, label.name)}</span>}
    </>
  );
  if (frame && onGoTo)
    return (
      <button type="button" {...common} title={`${label.name}\nIn ${frame.name} on the board. Click to go there`} onClick={() => onGoTo(frame.id)}>
        {body}
      </button>
    );
  const title =
    label.kind === 'tag' ? `Tag ${label.name}` : label.offBoard ? `${label.name}\nChecked out in a folder that isn’t on the board` : label.name;
  return (
    <span {...common} title={title}>
      {body}
    </span>
  );
}

function GraphCell({ row, width, head }: { row: GraphRow; width: number; head: boolean }) {
  const x = laneX(row.lane);
  const y = ROW_H / 2;
  return (
    <svg className="scm-graph-cell" width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`} aria-hidden="true" focusable="false">
      {row.top.map((l, i) => (
        <path key={`t${i}`} d={linePath(l, 'top')} className="scm-graph-line" data-tone={l.tone} />
      ))}
      {row.bottom.map((l, i) => (
        <path key={`b${i}`} d={linePath(l, 'bottom')} className="scm-graph-line" data-tone={l.tone} />
      ))}
      {head ? (
        <circle cx={x} cy={y} r={4} className="scm-graph-dot" data-tone={row.tone} data-head />
      ) : row.merge ? (
        <>
          <circle cx={x} cy={y} r={4.5} className="scm-graph-node" data-tone={row.tone} />
          <circle cx={x} cy={y} r={1.5} className="scm-graph-dot" data-tone={row.tone} />
        </>
      ) : (
        <circle cx={x} cy={y} r={3.5} className="scm-graph-node" data-tone={row.tone} />
      )}
    </svg>
  );
}

function CommitFiles({ row, width, commit, files }: { row: GraphRow; width: number; commit: CommitInfo; files: Files }) {
  return (
    <div className="scm-graph-files" aria-label={`Files in ${commit.shortHash}`}>
      <svg className="scm-graph-through" width={width} aria-hidden="true" focusable="false">
        {row.through.map((t) => (
          <line key={t.lane} x1={laneX(t.lane)} x2={laneX(t.lane)} y1="0" y2="100%" className="scm-graph-line" data-tone={t.tone} />
        ))}
      </svg>
      <div className="scm-graph-files-body">
        <span className="scm-muted scm-small">
          {commit.author} · {relativeTime(commit.at)} · <span className="scm-mono">{commit.shortHash}</span>
          {commit.parents && commit.parents.length > 1 ? ` · merge of ${commit.parents.length} parents` : ''}
        </span>
        {files.state === 'loading' && <span className="scm-muted scm-small">Loading files…</span>}
        {files.state === 'error' && <span className="scm-muted scm-small">{files.message}</span>}
        {files.state === 'ready' && files.files.length === 0 && <span className="scm-muted scm-small">No file changes</span>}
        {files.state === 'ready' && files.files.length > 0 && (
          <div role="list">
            {files.files.slice(0, MAX_FILES).map((f) => {
              const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
              return (
                <div key={f.path} role="listitem" className="scm-graph-file" data-kind={f.kind} title={f.fromPath ? `${f.fromPath} → ${f.path}` : f.path}>
                  <span className="scm-name" data-deleted={f.kind === 'deleted' || undefined}>
                    {baseName(f.path)}
                  </span>
                  {dir && <span className="scm-desc">{dir}</span>}
                  <span className="scm-letter" aria-label={KIND_LABEL[f.kind]}>
                    {LETTER[f.kind]}
                  </span>
                </div>
              );
            })}
            {files.files.length > MAX_FILES && <span className="scm-muted scm-small">{files.files.length - MAX_FILES} more files</span>}
          </div>
        )}
      </div>
    </div>
  );
}
