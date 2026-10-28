// Settings（TC-15，IS-13）：左边项目列表和 General，右边那一页。
// 各页改的是草稿，换页不丢；Save 把所有改过的页一起保存（项目 → projects.update，General → app.updateSettings），
// 都成功才关掉，失败的由控制器提示。Agents、Approvals 两页以后再加，现在只能在 settings.json 里改。

import { useEffect, useState } from 'react';
import type { BranchInfo, Project, Settings } from '@agentdeck/contracts';
import { Button, Dialog, DialogText, RadioGroup } from '@agentdeck/ui-kit';
import {
  BUILT_IN_RESUME_PROMPT,
  generalDraft,
  generalPatch,
  projectDraft,
  projectDraftError,
  projectPatch,
  type GeneralSettings,
  type ProjectDraft,
} from '../model/settings.ts';
import type { DialogState } from '../store.ts';
import { Checkbox, Field, Select, TextArea, TextInput } from './fields.tsx';
import { useBoardState, useController } from './context.tsx';

type SettingsDialogState = Extract<DialogState, { kind: 'settings' }>;

/** Workbench 里渲染：对话框开着且是 Settings 时出现。 */
export function SettingsDialogHost({ onOpenSettingsFile }: { onOpenSettingsFile?: (() => void) | undefined }) {
  const dialog = useBoardState((s) => (s.dialog?.kind === 'settings' ? s.dialog : null));
  if (!dialog) return null;
  return <SettingsDialog dialog={dialog} onOpenSettingsFile={onOpenSettingsFile} />;
}

function SettingsDialog({ dialog, onOpenSettingsFile }: { dialog: SettingsDialogState; onOpenSettingsFile: (() => void) | undefined }) {
  const c = useController();
  const projects = useBoardState((s) => s.projects);
  const [drafts, setDrafts] = useState<Record<string, ProjectDraft>>({});
  const [settings, setSettings] = useState<Settings | null>(null);
  const [general, setGeneral] = useState<GeneralSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    c.api.app
      .getSettings()
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        setGeneral(generalDraft(s));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [c]);

  const project = dialog.section === 'projects' ? (projects.find((p) => p.id === dialog.projectId) ?? null) : null;
  const draftOf = (p: Project) => drafts[p.id] ?? projectDraft(p);
  const editProject = (p: Project, change: Partial<ProjectDraft>) => setDrafts((all) => ({ ...all, [p.id]: { ...(all[p.id] ?? projectDraft(p)), ...change } }));

  const changedProjects = projects
    .filter((p) => drafts[p.id])
    .map((p) => ({ project: p, draft: drafts[p.id]!, patch: projectPatch(p, drafts[p.id]!) }))
    .filter((x) => Object.keys(x.patch).length > 0);
  const generalChanges = settings && general ? generalPatch(settings, general) : {};
  const invalid = changedProjects.some((x) => projectDraftError(x.draft, x.project.kind) !== null);
  const dirty = changedProjects.length > 0 || Object.keys(generalChanges).length > 0;

  const save = async () => {
    if (!dirty || invalid || saving) return;
    setSaving(true);
    const results = await Promise.all([
      ...changedProjects.map((x) => c.saveProjectSettings(x.project.id, x.patch)),
      ...(Object.keys(generalChanges).length ? [c.saveAppSettings(generalChanges)] : []),
    ]);
    setSaving(false);
    if (results.every(Boolean)) {
      c.closeDialog();
      return;
    }
    // 保存成功的页不再算改过：草稿丢掉，下次从新的项目 / 设置重新抄
    setDrafts((all) => {
      const next = { ...all };
      changedProjects.forEach((x, i) => {
        if (results[i]) delete next[x.project.id];
      });
      return next;
    });
  };

  const openFile = () => {
    c.closeDialog();
    onOpenSettingsFile?.();
  };

  return (
    <Dialog
      open
      title="Settings"
      width={720}
      onClose={() => c.closeDialog()}
      actions={
        <>
          {onOpenSettingsFile ? (
            <Button variant="ghost" className="ad-settings-file" onClick={openFile}>
              Open settings.json
            </Button>
          ) : null}
          <Button onClick={() => c.closeDialog()}>Cancel</Button>
          <Button variant="primary" disabled={!dirty || invalid || saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="ad-settings">
        {/* 打开时焦点放在当前这一页的按钮上（Dialog 找 data-autofocus） */}
        <nav className="ad-settings-nav" aria-label="Settings sections">
          <span className="ad-settings-nav-heading">Projects</span>
          {projects.length === 0 ? <span className="ad-settings-nav-empty">No projects yet</span> : null}
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className="ad-settings-nav-item"
              aria-current={project?.id === p.id ? 'page' : undefined}
              data-autofocus={project?.id === p.id || undefined}
              onClick={() => c.openSettings({ section: 'projects', projectId: p.id })}
            >
              <span className="ad-settings-nav-label">{drafts[p.id]?.name.trim() || p.name}</span>
              {p.missing ? <span className="ad-settings-nav-hint">Not found</span> : null}
            </button>
          ))}
          <span className="ad-settings-nav-rule" />
          <button
            type="button"
            className="ad-settings-nav-item"
            aria-current={!project ? 'page' : undefined}
            data-autofocus={!project || undefined}
            onClick={() => c.openSettings({ section: 'general' })}
          >
            <span className="ad-settings-nav-label">General</span>
          </button>
        </nav>
        <div className="ad-settings-page">
          {project ? (
            <ProjectPage key={project.id} project={project} draft={draftOf(project)} onChange={(change) => editProject(project, change)} />
          ) : general ? (
            <GeneralPage value={general} onChange={(change) => setGeneral((g) => (g ? { ...g, ...change } : g))} />
          ) : (
            <DialogText tone="muted">Loading…</DialogText>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ---- 项目 ----

function ProjectPage({ project, draft, onChange }: { project: Project; draft: ProjectDraft; onChange(change: Partial<ProjectDraft>): void }) {
  const c = useController();
  const [branches, setBranches] = useState<Record<string, BranchInfo[]>>({});
  const error = projectDraftError(draft, project.kind);

  // 每个仓库的分支，给 Base branch 选。文件夹找不到时不取。
  useEffect(() => {
    if (project.missing) return;
    let alive = true;
    for (const repo of project.repos) {
      c.api.git
        .branches(repo.path)
        .then((list) => {
          if (alive) setBranches((all) => ({ ...all, [repo.name]: list }));
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [c, project.id, project.missing, project.repos]);

  const browse = async () => {
    const folder = await c.api.app.pickFolder({ title: 'Worktree location', defaultPath: draft.worktreeRoot }).catch(() => null);
    if (folder) onChange({ worktreeRoot: folder });
  };

  return (
    <>
      <Field label="Name">
        <TextInput aria-label="Name" value={draft.name} invalid={error === 'name'} onChange={(name) => onChange({ name })} />
      </Field>
      <Field label="Path">
        <div className="ad-field-row">
          <span className="ad-settings-path" title={project.path}>
            {project.path}
          </span>
          {project.missing ? (
            <>
              <span className="ad-field-hint">Folder not found</span>
              <Button size="sm" onClick={() => void c.locateProject(project.id)}>
                Locate…
              </Button>
            </>
          ) : null}
        </div>
      </Field>
      {project.kind === 'plain' ? (
        <DialogText tone="muted">This folder has no git. Worktree settings appear once it has a repository.</DialogText>
      ) : (
        <>
          {project.repos.map((repo) => {
            const current = draft.baseBranch[repo.name] ?? repo.baseBranch;
            const names = (branches[repo.name] ?? []).map((b) => b.name);
            if (!names.includes(current)) names.unshift(current);
            const label = project.kind === 'multi-repo' ? `Base branch · ${repo.name}` : 'Base branch';
            return (
              <Field key={repo.name} label={label}>
                <Select
                  aria-label={label}
                  value={current}
                  options={names.map((n) => ({ value: n, label: n }))}
                  onChange={(b) => onChange({ baseBranch: { ...draft.baseBranch, [repo.name]: b } })}
                />
              </Field>
            );
          })}
          <Field label="Worktree location">
            <div className="ad-field-row">
              <TextInput
                aria-label="Worktree location"
                value={draft.worktreeRoot}
                invalid={error === 'worktreeRoot'}
                onChange={(worktreeRoot) => onChange({ worktreeRoot })}
              />
              <Button size="sm" onClick={() => void browse()}>
                Browse…
              </Button>
            </div>
          </Field>
          <Field label="Files to copy">
            <TextArea aria-label="Files to copy" value={draft.copy} placeholder=".env" onChange={(copy) => onChange({ copy })} />
            <span className="ad-settings-hint">One per line, copied from the project folder into each new worktree</span>
          </Field>
          <Field label="Setup command">
            <TextInput aria-label="Setup command" value={draft.setup} placeholder="pnpm install" onChange={(setup) => onChange({ setup })} />
            <span className="ad-settings-hint">Runs in a Shell inside each new worktree</span>
          </Field>
        </>
      )}
    </>
  );
}

// ---- General ----

function GeneralPage({ value, onChange }: { value: GeneralSettings; onChange(change: Partial<GeneralSettings>): void }) {
  const agents = useBoardState((s) => s.agents);
  const options = agents.map((a) => ({ value: a.id, label: a.label, ...(a.installed ? {} : { hint: 'Not installed', disabled: true }) }));
  if (!options.some((o) => o.value === value.defaultAgent)) options.unshift({ value: value.defaultAgent, label: value.defaultAgent });
  return (
    <>
      <Field label="Closing the window">
        <RadioGroup
          aria-label="Closing the window"
          value={value.closeWindow}
          onChange={(closeWindow) => onChange({ closeWindow })}
          options={[
            { value: 'background', label: 'Keep AgentDeck running in the background' },
            { value: 'quit', label: 'Quit AgentDeck' },
          ]}
        />
      </Field>
      <Field label="Notifications">
        <Checkbox checked={value.notifications} onChange={(notifications) => onChange({ notifications })}>
          Notify me when a terminal needs me and AgentDeck is in the background
        </Checkbox>
      </Field>
      <Field label="Default agent">
        <Select aria-label="Default agent" value={value.defaultAgent} options={options} onChange={(defaultAgent) => onChange({ defaultAgent })} />
      </Field>
      <Field label="Editor command">
        <TextInput aria-label="Editor command" value={value.editorCommand} placeholder="code -g" onChange={(editorCommand) => onChange({ editorCommand })} />
        <span className="ad-settings-hint">Opens files from the side panel and settings.json</span>
      </Field>
      <Field label="Terminal app">
        <TextInput aria-label="Terminal app" value={value.terminalApp} placeholder="Terminal" onChange={(terminalApp) => onChange({ terminalApp })} />
        <span className="ad-settings-hint">Used by Open in system terminal, for example Terminal, iTerm or Ghostty</span>
      </Field>
      <Field label="Resume prompt">
        <TextArea aria-label="Resume prompt" value={value.resumePrompt} placeholder={BUILT_IN_RESUME_PROMPT} onChange={(resumePrompt) => onChange({ resumePrompt })} />
        <span className="ad-settings-hint">Auto-resume sends this when a usage limit resets. Empty uses the built-in text; you can still change it for one limit from the bookmark</span>
      </Field>
    </>
  );
}
