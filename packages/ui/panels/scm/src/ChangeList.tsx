// Merge Changes / Staged Changes / Changes 三组，每组按文件夹树形列出。
// 悬停一行出现操作：Changes 里 + 暂存、放弃；Staged 里 − 取消暂存；冲突 + 标记已解决。单击看差异，双击在编辑器里打开。

import { useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronIcon, DiscardIcon, MinusIcon, PlusIcon } from './icons.tsx';
import { KIND_LABEL, buildTree, filesUnder, type ChangeGroup, type ChangeRow, type GroupKind, type TreeNode } from './model.ts';

export interface ChangeActions {
  stage(rows: ChangeRow[]): void;
  unstage(rows: ChangeRow[]): void;
  discard(rows: ChangeRow[], label: string): void;
  openDiff(row: ChangeRow, group: GroupKind): void;
  openFile(row: ChangeRow): void;
}

export function ChangeList({ groups, actions, disabled }: { groups: ChangeGroup[]; actions: ChangeActions; disabled: boolean }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (!n.delete(key)) n.add(key);
      return n;
    });

  return (
    <div className="scm-groups">
      {groups.map((g) => {
        const open = !collapsed.has(g.kind);
        const rows = g.rows;
        return (
          <section key={g.kind} className="scm-group" aria-label={g.title}>
            <div className="scm-row scm-row--group">
              <button type="button" className="scm-row-main" aria-expanded={open} onClick={() => toggle(g.kind)}>
                <ChevronIcon open={open} />
                <span className="scm-group-title">{g.title}</span>
                <span className="scm-count">{rows.length}</span>
              </button>
              <RowActions group={g.kind} rows={rows} label={`all ${g.title.toLowerCase()}`} actions={actions} disabled={disabled} />
            </div>
            {open && (
              <div role="list">
                <Tree nodes={buildTree(rows)} depth={1} group={g.kind} collapsed={collapsed} toggle={toggle} actions={actions} disabled={disabled} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Tree(props: {
  nodes: TreeNode[];
  depth: number;
  group: GroupKind;
  collapsed: ReadonlySet<string>;
  toggle: (key: string) => void;
  actions: ChangeActions;
  disabled: boolean;
}): ReactNode {
  const { nodes, depth, group, collapsed, toggle, actions, disabled } = props;
  const indent = { '--depth': depth } as CSSProperties;
  return nodes.map((n) => {
    if (n.type === 'folder') {
      const key = `${group}:${n.path}`;
      const open = !collapsed.has(key);
      const rows = filesUnder(n);
      return (
        <div key={key} role="listitem">
          <div className="scm-row scm-row--folder" style={indent}>
            <button type="button" className="scm-row-main" aria-expanded={open} onClick={() => toggle(key)} title={n.path}>
              <ChevronIcon open={open} />
              <span className="scm-name">{n.name}</span>
            </button>
            <RowActions group={group} rows={rows} label={`${n.path}/`} actions={actions} disabled={disabled} />
          </div>
          {open && <Tree {...props} nodes={n.children} depth={depth + 1} />}
        </div>
      );
    }
    const { row } = n;
    const f = row.file;
    const desc = f.submodule ? 'Submodule changed' : f.fromPath ? `from ${f.fromPath}` : '';
    return (
      <div key={`${group}:${n.path}`} role="listitem" className="scm-row scm-row--file" style={indent} data-kind={row.kind}>
        <button
          type="button"
          className="scm-row-main"
          title={`${f.path} · ${f.conflicted ? 'Conflict' : KIND_LABEL[row.kind]}`}
          onClick={() => actions.openDiff(row, group)}
          onDoubleClick={() => actions.openFile(row)}
        >
          <span className="scm-name" data-deleted={row.kind === 'deleted' || undefined}>
            {n.name}
          </span>
          {desc && <span className="scm-desc">{desc}</span>}
        </button>
        <RowActions group={group} rows={[row]} label={n.name} actions={actions} disabled={disabled} />
        <span className="scm-letter" data-conflict={f.conflicted || undefined} aria-label={f.conflicted ? 'Conflict' : KIND_LABEL[row.kind]}>
          {row.letter}
        </span>
      </div>
    );
  });
}

function RowActions({
  group,
  rows,
  label,
  actions,
  disabled,
}: {
  group: GroupKind;
  rows: ChangeRow[];
  label: string;
  actions: ChangeActions;
  disabled: boolean;
}) {
  return (
    <span className="scm-actions">
      {group === 'changes' && (
        <button type="button" className="scm-icon-button" aria-label={`Discard changes to ${label}`} title="Discard changes" disabled={disabled} onClick={() => actions.discard(rows, label)}>
          <DiscardIcon />
        </button>
      )}
      {group === 'staged' ? (
        <button type="button" className="scm-icon-button" aria-label={`Unstage ${label}`} title="Unstage" disabled={disabled} onClick={() => actions.unstage(rows)}>
          <MinusIcon />
        </button>
      ) : (
        <button
          type="button"
          className="scm-icon-button"
          aria-label={`${group === 'merge' ? 'Mark resolved' : 'Stage'} ${label}`}
          title={group === 'merge' ? 'Mark resolved' : 'Stage'}
          disabled={disabled}
          onClick={() => actions.stage(rows)}
        >
          <PlusIcon />
        </button>
      )}
    </span>
  );
}
