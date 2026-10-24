// 白板的对话框：新建工作区（W3）、删除工作区（W4 的界面部分）、终端不能换框（W5）、停止终端、改名。Settings 在 SettingsDialog.tsx。

import { useEffect, useRef, useState } from 'react';
import type { BranchInfo, CreateWorkspaceRequest, Project, ProjectId, WorkspaceMode } from '@agentdeck/contracts';
import { Button, Dialog, DialogText, RadioGroup } from '@agentdeck/ui-kit';
import { statusOf } from '../model/attention.ts';
import { validateBranchName } from '../model/branch.ts';
import { defaultName } from '../model/windows.ts';
import type { DialogState } from '../store.ts';
import { Checkbox, Field, Select, TextInput } from './fields.tsx';
import { useBoardState, useController } from './context.tsx';

export function BoardDialogs() {
  const dialog = useBoardState((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'new-workspace':
      return <NewWorkspaceDialog key="new-workspace" dialog={dialog} />;
    case 'remove-workspace':
      return <RemoveWorkspaceDialog dialog={dialog} />;
    case 'move-terminal':
      return <MoveTerminalDialog dialog={dialog} />;
    case 'stop-terminal':
      // 画在那个终端窗口里面（WindowNodeView），不盖住整个应用
      return null;
    case 'rename-window':
    case 'rename-workspace':
      return <RenameDialog dialog={dialog} />;
    case 'settings':
      // Workbench 里的 SettingsDialogHost 画它（要用 Workbench 的 onOpenSettingsFile）
      return null;
  }
}

type Of<K extends DialogState['kind']> = Extract<DialogState, { kind: K }>;

// ---- 新建工作区 ----

function NewWorkspaceDialog({ dialog }: { dialog: Of<'new-workspace'> }) {
  const c = useController();
  const projects = useBoardState((s) => s.projects);
  const [projectId, setProjectId] = useState<ProjectId | null>(dialog.projectId);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const mainOnBoard = project ? c.mainFolderOnBoard(project.id) : false;
  const canWorktree = project ? project.kind !== 'plain' : false;
  const [mode, setMode] = useState<WorkspaceMode>('worktree');
  const [branchKind, setBranchKind] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState('');
  const [from, setFrom] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [touched, setTouched] = useState(false);

  // 换项目时：重新取分支，按能不能建 worktree、主目录在不在白板上选默认的 Folder
  useEffect(() => {
    setBranches([]);
    setFrom(null);
    setExisting(null);
    const project = c.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    setMode(project.kind === 'plain' ? 'main-folder' : 'worktree');
    const repo = project.repos[0];
    if (!repo) return;
    let alive = true;
    c.api.git
      .branches(repo.path)
      .then((list) => {
        if (!alive) return;
        setBranches(list);
        setFrom(project.kind === 'multi-repo' ? null : repo.baseBranch);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [c, projectId]);

  const free = branches.filter((b) => !b.checkedOutAt);
  const nameError = mode === 'worktree' && branchKind === 'new' ? validateBranchName(name) : null;
  const exists = mode === 'worktree' && branchKind === 'new' && branches.some((b) => b.name === name.trim());
  const ready =
    !!project &&
    (mode === 'main-folder'
      ? !mainOnBoard
      : canWorktree && (branchKind === 'new' ? !nameError && !exists : !!existing));

  const submit = () => {
    setTouched(true);
    if (!ready || !project) return;
    const req: CreateWorkspaceRequest =
      mode === 'main-folder'
        ? { projectId: project.id, mode }
        : {
            projectId: project.id,
            mode,
            branch:
              branchKind === 'new'
                ? { kind: 'new', name: name.trim(), ...(from ? { from } : {}) }
                : { kind: 'existing', name: existing! },
          };
    void c.createWorkspace(req, dialog.at);
  };

  return (
    <Dialog
      open
      title="New workspace"
      width={440}
      onClose={() => c.closeDialog()}
      actions={
        <>
          <Button onClick={() => c.closeDialog()}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <Field label="Project">
        <Select
          aria-label="Project"
          value={projectId}
          placeholder="Choose a project"
          options={projects.map((p: Project) => ({ value: p.id, label: p.name, ...(p.missing ? { hint: 'Folder not found', disabled: true } : {}) }))}
          onChange={(v) => setProjectId(v as ProjectId)}
          extra={[{ id: 'add-project', label: 'Add project…', onSelect: () => void c.addProject(dialog.at) }]}
        />
      </Field>
      {project ? (
        <>
          <Field label="Folder">
            <RadioGroup
              aria-label="Folder"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'worktree', label: 'New worktree', disabled: !canWorktree, ...(canWorktree ? {} : { description: 'This folder has no git' }) },
                { value: 'main-folder', label: 'Main folder', disabled: mainOnBoard, ...(mainOnBoard ? { description: 'Already on board' } : {}) },
              ]}
            />
          </Field>
          {mode === 'worktree' && canWorktree ? (
            <>
              <Field label="Branch">
                <RadioGroup
                  aria-label="Branch"
                  value={branchKind}
                  onChange={setBranchKind}
                  options={[
                    { value: 'new', label: 'New branch' },
                    { value: 'existing', label: 'Existing', disabled: free.length === 0 },
                  ]}
                />
              </Field>
              {branchKind === 'new' ? (
                <Field label="Name">
                  <div className="ad-field-row">
                    <TextInput
                      aria-label="Branch name"
                      value={name}
                      placeholder="feat/oauth"
                      autoFocus
                      invalid={touched && (!!nameError || exists)}
                      onChange={setName}
                      onEnter={submit}
                    />
                    {project.kind === 'multi-repo' ? (
                      <span className="ad-field-hint">from each repo’s base branch</span>
                    ) : (
                      <>
                        <span className="ad-field-hint">from</span>
                        <Select
                          aria-label="Base branch"
                          value={from}
                          options={branches.map((b) => ({ value: b.name, label: b.name }))}
                          onChange={setFrom}
                        />
                      </>
                    )}
                  </div>
                </Field>
              ) : (
                <Field label="Name">
                  <Select
                    aria-label="Existing branch"
                    value={existing}
                    placeholder="Choose a branch"
                    options={free.map((b) => ({ value: b.name, label: b.name }))}
                    onChange={setExisting}
                  />
                </Field>
              )}
              {exists ? (
                <div className="ad-field-row">
                  <DialogText tone="muted">Branch {name.trim()} already exists</DialogText>
                  <Button
                    size="sm"
                    onClick={() => {
                      setBranchKind('existing');
                      setExisting(name.trim());
                    }}
                  >
                    Use existing branch
                  </Button>
                </div>
              ) : touched && nameError ? (
                <DialogText tone="muted">{nameError}</DialogText>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <DialogText tone="muted">Add a project to create a workspace in it.</DialogText>
      )}
    </Dialog>
  );
}

// ---- 删除工作区 ----

function RemoveWorkspaceDialog({ dialog }: { dialog: Of<'remove-workspace'> }) {
  const c = useController();
  const ws = useBoardState((s) => s.workspaces[dialog.workspaceId]);
  const [choice, setChoice] = useState<'board' | 'folder'>('board');
  const [understood, setUnderstood] = useState(false);
  const label = c.workspaceTitle(dialog.workspaceId);
  const running = c.runningTerminalNames(dialog.workspaceId);
  const isMain = ws?.mode === 'main-folder';
  const deleteFolder = choice === 'folder' && !isMain;
  const blocked = dialog.busy || (deleteFolder && dialog.dirty && !understood);

  return (
    <Dialog
      open
      title={`Delete workspace ${label}`}
      width={440}
      onClose={() => c.closeDialog()}
      actions={
        <>
          <Button onClick={() => c.closeDialog()}>Cancel</Button>
          <Button
            variant="primary"
            disabled={blocked}
            onClick={() => void c.removeWorkspace(dialog.workspaceId, deleteFolder, deleteFolder && dialog.dirty && understood)}
          >
            Delete
          </Button>
        </>
      }
    >
      {running.length ? <DialogText tone="muted">{listNames(running)} will be stopped</DialogText> : null}
      <RadioGroup
        aria-label="What to delete"
        value={choice}
        onChange={(v) => {
          setChoice(v);
          setUnderstood(false);
        }}
        options={[
          { value: 'board', label: 'Remove from board', description: 'Keeps the folder and branch' },
          {
            value: 'folder',
            label: 'Also delete the worktree folder',
            disabled: isMain,
            description: isMain ? 'This is the project’s main folder' : 'The branch is kept',
          },
        ]}
      />
      {deleteFolder && dialog.dirty ? (
        <>
          <DialogText tone="attention">Uncommitted changes in this worktree will be lost</DialogText>
          <Checkbox checked={understood} onChange={setUnderstood} autoFocus>
            I understand these changes will be lost
          </Checkbox>
        </>
      ) : null}
      {dialog.error ? <DialogText tone="muted">{dialog.error}</DialogText> : null}
    </Dialog>
  );
}

/** ['claude', 'zsh'] → “claude and zsh”；三个以上 “claude, codex and zsh”。 */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ---- W5：终端不能换框 ----

function MoveTerminalDialog({ dialog }: { dialog: Of<'move-terminal'> }) {
  const c = useController();
  return (
    <Dialog
      open
      title="Terminals can’t change folders"
      width={420}
      onClose={() => c.closeDialog()}
      actions={
        <>
          <Button onClick={() => c.closeDialog()}>Cancel</Button>
          <Button variant="primary" data-autofocus onClick={() => void c.openInWorkspace(dialog.windowId, dialog.to, dialog.at)}>
            Open new
          </Button>
        </>
      }
    >
      <DialogText>{c.moveTerminalMessage(dialog.windowId, dialog.to)}</DialogText>
    </Dialog>
  );
}

// ---- 停止终端 ----

/**
 * 关闭运行中的终端前的确认：画在那个终端窗口里面，只盖住这个窗口，白板上别的东西照常能看能用。
 * 标题带上当前对话的主题（程序设的终端标题），例如 “Stop claude · Check local git history?”。
 * Esc 取消，焦点默认在 Stop and close 上（↩ 确认）。
 */
export function WindowStopConfirm({ dialog }: { dialog: Of<'stop-terminal'> }) {
  const c = useController();
  const w = c.windowById(dialog.windowId);
  const status = useBoardState((s) => (w ? statusOf(w, s.statuses)?.status : undefined));
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus({ preventScroll: true }), []);
  const name = w ? (w.title ?? defaultName(w, c.definitionOf(w)?.label)) : 'terminal';
  const titleId = `stop-${dialog.windowId}`;
  const busy = status === undefined || status === 'running' || status === 'starting';
  return (
    <div
      className="ad-window-confirm nodrag nopan nowheel"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        c.closeDialog();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="ad-dialog ad-window-confirm__card">
        <h2 className="ad-dialog-title ad-window-confirm__title" id={titleId} title={dialog.topic ?? undefined}>
          Stop {name}
          {dialog.topic ? <span className="ad-window-confirm__topic"> · {dialog.topic}</span> : null}?
        </h2>
        <div className="ad-dialog-body">
          <DialogText tone="muted">{busy ? 'The current task will be interrupted.' : `${name} will exit and this window will close.`}</DialogText>
        </div>
        <div className="ad-dialog-actions">
          <Button onClick={() => c.closeDialog()}>Cancel</Button>
          <Button ref={confirmRef} variant="primary" onClick={() => void c.stopAndClose(dialog.windowId)}>
            Stop and close
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- 改名 ----

function RenameDialog({ dialog }: { dialog: Of<'rename-window'> | Of<'rename-workspace'> }) {
  const c = useController();
  const initial =
    dialog.kind === 'rename-window'
      ? (c.windowById(dialog.windowId)?.title ?? '')
      : (c.state.workspaces[dialog.workspaceId]?.name ?? '');
  const [value, setValue] = useState(initial);
  const save = () => {
    if (dialog.kind === 'rename-window') c.renameWindow(dialog.windowId, value);
    else void c.renameWorkspace(dialog.workspaceId, value);
    c.closeDialog();
  };
  return (
    <Dialog
      open
      title={dialog.kind === 'rename-window' ? 'Rename window' : 'Rename workspace'}
      width={360}
      onClose={() => c.closeDialog()}
      actions={
        <>
          <Button onClick={() => c.closeDialog()}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Rename
          </Button>
        </>
      }
    >
      <TextInput aria-label="Name" value={value} autoFocus onChange={setValue} onEnter={save} />
    </Dialog>
  );
}
