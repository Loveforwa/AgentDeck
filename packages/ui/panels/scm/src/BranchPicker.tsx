// 分支下拉：搜索框、本地分支、New branch…。被别的工作区检出的分支灰显，单击跳到那个框。

import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { AbsPath, BranchInfo, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { Popover, type PopoverAnchor } from '@agentdeck/ui-kit';
import { CheckIcon } from './icons.tsx';
import { toErrorData, type ScmApi } from './useScm.ts';

export interface BranchPickerProps {
  api: ScmApi;
  anchor: PopoverAnchor;
  repoPath: AbsPath;
  workspaces: readonly Workspace[];
  onClose(): void;
  onPick(branch: string): void;
  onGoTo?(workspaceId: WorkspaceId): void;
  onNewBranch(): void;
}

interface Option {
  key: string;
  label: string;
  note: string;
  current: boolean;
  /** 被别的工作区检出：灰显；能跳过去时单击跳到那个框。 */
  occupiedBy: Workspace | null;
  occupied: boolean;
  run: (() => void) | null;
}

export function BranchPicker({ api, anchor, repoPath, workspaces, onClose, onPick, onGoTo, onNewBranch }: BranchPickerProps) {
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    let live = true;
    api.git.branches(repoPath).then(
      (b) => live && setBranches(b),
      (e: unknown) => live && setError(toErrorData(e).message),
    );
    return () => {
      live = false;
    };
  }, [api, repoPath]);

  const options = useMemo<Option[]>(() => {
    const q = query.trim().toLowerCase();
    const list = (branches ?? [])
      .filter((b) => q === '' || b.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.current) - Number(a.current))
      .map((b): Option => {
        const elsewhere = b.checkedOutAt !== null && b.checkedOutAt !== repoPath && !b.current;
        const ws = elsewhere ? (workspaces.find((w) => w.path === b.checkedOutAt || w.repos.some((r) => r.path === b.checkedOutAt)) ?? null) : null;
        const note = !elsewhere ? '' : ws ? (ws.mode === 'main-folder' ? 'in main folder' : `in ${ws.name}`) : 'in another folder';
        let run: (() => void) | null = null;
        if (b.current) run = null;
        else if (!elsewhere) run = () => onPick(b.name);
        else if (ws && onGoTo) run = () => onGoTo(ws.id);
        return { key: `b:${b.name}`, label: b.name, note, current: b.current, occupiedBy: ws, occupied: elsewhere, run };
      });
    list.push({ key: 'new', label: 'New branch…', note: '', current: false, occupiedBy: null, occupied: false, run: onNewBranch });
    return list;
  }, [branches, query, repoPath, workspaces, onPick, onGoTo, onNewBranch]);

  const clamp = (i: number) => Math.max(0, Math.min(options.length - 1, i));
  const choose = (o: Option | undefined) => {
    if (!o?.run) return;
    onClose();
    o.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => clamp(i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => clamp(i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(options[clamp(active)]);
    }
  };

  const activeOption = options[clamp(active)];
  return (
    <Popover open anchor={anchor} onClose={onClose} role="dialog" aria-label="Switch branch" className="scm-branch-popover">
      <input
        className="scm-input scm-branch-search"
        placeholder="Search branches"
        aria-label="Search branches"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={activeOption ? `${listId}-${activeOption.key}` : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="scm-branch-list" role="listbox" id={listId} aria-label="Branches">
        {branches === null && !error && <div className="scm-muted scm-branch-note">Loading branches…</div>}
        {error && <div className="scm-muted scm-branch-note">{error}</div>}
        {options.map((o, i) => (
          <div key={o.key}>
            {o.key === 'new' && <div className="scm-separator" role="separator" />}
            <div
              id={`${listId}-${o.key}`}
              role="option"
              aria-selected={o.current}
              aria-disabled={(o.run === null && !o.current) || undefined}
              className="scm-branch-option"
              data-active={i === clamp(active) || undefined}
              data-occupied={o.occupied || undefined}
              title={o.occupied ? (o.occupiedBy && onGoTo ? `Checked out ${o.note}. Click to go there.` : `Checked out ${o.note}`) : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o)}
            >
              <span className="scm-branch-check">{o.current && <CheckIcon />}</span>
              <span className={o.key === 'new' ? 'scm-branch-name scm-branch-name--action' : 'scm-branch-name'}>{o.label}</span>
              {o.note && <span className="scm-branch-option-note">{o.note}</span>}
            </div>
          </div>
        ))}
      </div>
    </Popover>
  );
}
