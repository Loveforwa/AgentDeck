// Settings 对话框（TC-15）的草稿：打开时从项目 / 设置抄一份，改的是草稿，Save 时只把改了的字段发给服务。

import type { Project, ProjectPatch, Settings } from '@agentdeck/contracts';

export interface ProjectDraft {
  name: string;
  worktreeRoot: string;
  /** Files to copy：一行一个。 */
  copy: string;
  /** Setup command，空字符串表示没有。 */
  setup: string;
  /** 按仓库名。 */
  baseBranch: Record<string, string>;
}

export function projectDraft(p: Project): ProjectDraft {
  return {
    name: p.name,
    worktreeRoot: p.worktreeRoot,
    copy: p.copyIntoWorktrees.join('\n'),
    setup: p.setupCommand ?? '',
    baseBranch: Object.fromEntries(p.repos.map((r) => [r.name, r.baseBranch])),
  };
}

/** 一行一个，去掉首尾空白和空行。 */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** 草稿和项目不一样的字段。没改返回空对象。 */
export function projectPatch(p: Project, d: ProjectDraft): ProjectPatch {
  const patch: ProjectPatch = {};
  const name = d.name.trim();
  if (name !== p.name) patch.name = name;
  const root = d.worktreeRoot.trim();
  if (root !== p.worktreeRoot) patch.worktreeRoot = root;
  const copy = parseLines(d.copy);
  if (copy.join('\n') !== p.copyIntoWorktrees.join('\n')) patch.copyIntoWorktrees = copy;
  const setup = d.setup.trim() || null;
  if (setup !== p.setupCommand) patch.setupCommand = setup;
  const branches: Record<string, string> = {};
  for (const r of p.repos) {
    const b = d.baseBranch[r.name];
    if (b && b !== r.baseBranch) branches[r.name] = b;
  }
  if (Object.keys(branches).length) patch.baseBranch = branches;
  return patch;
}

/** 草稿里不能保存的地方（名字或 worktree 位置为空）。 */
export function projectDraftError(d: ProjectDraft, kind: Project['kind']): 'name' | 'worktreeRoot' | null {
  if (!d.name.trim()) return 'name';
  if (kind !== 'plain' && !d.worktreeRoot.trim()) return 'worktreeRoot';
  return null;
}

/**
 * General 页的字段。agents、approvals 以后有自己的页面。
 * resumePrompt（PL6）：Settings › Resume prompt，续跑时发的模板；空的用内置的那段（Settings 里不填）。等 Agents 页（AH4）有了再挪过去。
 */
export type GeneralSettings = Pick<Settings, 'closeWindow' | 'notifications' | 'editorCommand' | 'terminalApp' | 'defaultAgent'> & { resumePrompt: string };

/** 内置的续跑模板（同 agent-adapters 的 DEFAULT_RESUME_PROMPT，界面不能 import 服务包，只当输入框的占位字）。 */
export const BUILT_IN_RESUME_PROMPT =
  "Your usage limit has reset. Continue the task you were working on when the limit stopped you, from where you left off. Don't redo work that is already done.";

export const GENERAL_KEYS = ['closeWindow', 'notifications', 'editorCommand', 'terminalApp', 'defaultAgent'] as const satisfies readonly (keyof GeneralSettings)[];

export function generalDraft(s: Settings): GeneralSettings {
  return {
    closeWindow: s.closeWindow,
    notifications: s.notifications,
    editorCommand: s.editorCommand,
    terminalApp: s.terminalApp,
    defaultAgent: s.defaultAgent,
    resumePrompt: s.resumePrompt ?? '',
  };
}

export function generalPatch(s: Settings, d: GeneralSettings): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of GENERAL_KEYS) {
    const v = typeof d[key] === 'string' ? (d[key] as string).trim() : d[key];
    if (v !== s[key]) Object.assign(patch, { [key]: v });
  }
  const resume = d.resumePrompt.trim();
  if (resume !== (s.resumePrompt ?? '').trim()) patch.resumePrompt = resume;
  return patch;
}
