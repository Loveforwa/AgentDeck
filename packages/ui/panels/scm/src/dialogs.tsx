// 面板里用到的确认框：切分支、放弃更改、新建分支、第一次 Commit all。

import { useState } from 'react';
import type { AgentDeckErrorData } from '@agentdeck/contracts';
import { Button, Dialog, DialogText } from '@agentdeck/ui-kit';
import { baseName } from './model.ts';
import type { ChangeRow } from './model.ts';

export function ErrorDetail({ error }: { error: AgentDeckErrorData }) {
  return (
    <div className="scm-error" role="alert">
      <span>{error.message}</span>
      {error.detail && error.detail !== error.message && (
        <details>
          <summary>Show output</summary>
          <pre className="scm-error-output">{error.detail}</pre>
        </details>
      )}
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function SwitchDialog(props: {
  branch: string;
  current: string | null;
  changes: number;
  agents: readonly string[];
  /** git 说带着改动切不过去（dirty-worktree）：不再提供 Switch with changes。 */
  carryRefused: boolean;
  error: AgentDeckErrorData | null;
  busy: boolean;
  onCancel(): void;
  onSwitch(strategy: 'carry' | 'stash'): void;
}) {
  const { branch, current, changes, agents, carryRefused, error, busy, onCancel, onSwitch } = props;
  const who = agents.length === 0 ? null : `${agents.join(' and ')} ${agents.length === 1 ? 'is' : 'are'} running in this folder.`;
  return (
    <Dialog
      open
      onClose={onCancel}
      title={changes > 0 ? plural(changes, 'uncommitted change') : `Switch to ${branch}?`}
      actions={
        changes > 0 ? (
          <>
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant={carryRefused ? 'primary' : 'default'} disabled={busy} onClick={() => onSwitch('stash')}>
              Stash and switch
            </Button>
            {!carryRefused && (
              <Button variant="primary" disabled={busy} onClick={() => onSwitch('carry')} data-autofocus>
                Switch with changes
              </Button>
            )}
          </>
        ) : (
          <>
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => onSwitch('carry')} data-autofocus>
              Switch
            </Button>
          </>
        )
      }
    >
      {who && <DialogText tone="attention">{who} Switching branches changes the files it sees.</DialogText>}
      {changes > 0 && (
        <DialogText tone="muted">
          {carryRefused
            ? `Your changes conflict with ${branch}. Stash them to switch; you can restore them when you come back${current ? ` to ${current}` : ''}.`
            : `Take them to ${branch}, or stash them and restore them when you come back${current ? ` to ${current}` : ''}.`}
        </DialogText>
      )}
      {error && <ErrorDetail error={error} />}
    </Dialog>
  );
}

export function DiscardDialog({ rows, label, onCancel, onConfirm }: { rows: ChangeRow[]; label: string; onCancel(): void; onConfirm(): void }) {
  const one = rows.length === 1 ? rows[0] : undefined;
  const untracked = one?.kind === 'untracked';
  const title = one
    ? untracked
      ? `Move ${baseName(one.file.path)} to Trash?`
      : `Discard changes to ${baseName(one.file.path)}?`
    : `Discard changes to ${plural(rows.length, 'file')} in ${label}?`;
  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      actions={
        <>
          <Button onClick={onCancel} data-autofocus>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            {untracked ? 'Move to Trash' : 'Discard'}
          </Button>
        </>
      }
    >
      <DialogText tone={untracked ? 'muted' : 'attention'}>
        {untracked
          ? 'You can get it back from the Trash.'
          : one
            ? 'This can’t be undone.'
            : 'This can’t be undone. Untracked files are moved to the Trash.'}
      </DialogText>
    </Dialog>
  );
}

export function NewBranchDialog(props: {
  from: string | null;
  error: AgentDeckErrorData | null;
  busy: boolean;
  onCancel(): void;
  onCreate(name: string): void;
}) {
  const [name, setName] = useState('');
  const ok = name.trim() !== '';
  return (
    <Dialog
      open
      onClose={props.onCancel}
      title="New branch"
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!ok || props.busy} onClick={() => props.onCreate(name.trim())}>
            Create and switch
          </Button>
        </>
      }
    >
      <label className="scm-field">
        <span className="scm-muted">Branch name</span>
        <input
          className="scm-input"
          value={name}
          placeholder="feat/my-change"
          data-autofocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ok) props.onCreate(name.trim());
          }}
        />
      </label>
      <DialogText tone="muted">Starts from the current commit{props.from ? ` on ${props.from}` : ''}. Your changes come along.</DialogText>
      {props.error && <ErrorDetail error={props.error} />}
    </Dialog>
  );
}

export function CommitAllDialog({ count, onCancel, onConfirm }: { count: number; onCancel(): void; onConfirm(): void }) {
  return (
    <Dialog
      open
      onClose={onCancel}
      title="There are no staged changes"
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm} data-autofocus>
            Commit all
          </Button>
        </>
      }
    >
      <DialogText>{count === 1 ? 'Commit the 1 changed file?' : `Commit all ${count} changes, including new files?`}</DialogText>
      <DialogText tone="muted">To commit only some files, stage them with + first. AgentDeck won’t ask again.</DialogText>
    </Dialog>
  );
}
