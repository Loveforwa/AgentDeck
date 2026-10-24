// Settings 对话框（TC-15）：打开的入口、改项目设置后新建 worktree 用上新的值、General 页、settings.json、出错提示。
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AbsPath, Project, TerminalWindowData, WindowComponentProps } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { generalDraft, generalPatch, parseLines, projectDraft, projectDraftError, projectPatch } from '../src/model/settings.ts';
import { Workbench } from '../src/react/Workbench.tsx';
import { createWindowRegistry } from '../src/registry.ts';

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
  globalThis.DOMMatrixReadOnly ??= class {
    m22 = 1;
    constructor(_t?: string) {}
  } as unknown as typeof DOMMatrixReadOnly;
});

const Nothing = (_p: WindowComponentProps<TerminalWindowData>) => null;

async function setup(opts: { onOpenSettingsFile?: () => void } = {}) {
  const registry = createWindowRegistry();
  registry.register<TerminalWindowData>({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    component: Nothing,
    create: (init) => ({ terminalId: null, agent: 'shell', cmd: 'zsh', args: [], cwd: '~', sessionId: null, startCommand: null, ...init }),
  });
  const api = createFakeApi();
  const c = new BoardController({ api, registry, homeDir: SAMPLE.home });
  render(<Workbench api={api} controller={c} {...opts} />);
  await waitFor(() => expect(c.state.loaded).toBe(true));
  return { api, c };
}

const MENU_ITEM = 'menuitemcheckbox';
const dialog = () => screen.getByRole('dialog', { name: 'Settings' });

/** 在对话框里的下拉中选一项。 */
async function choose(select: string, option: string) {
  fireEvent.click(within(dialog()).getByRole('button', { name: select }));
  fireEvent.click(await screen.findByRole(MENU_ITEM, { name: option }));
}

describe('Settings dialog (TC-15)', () => {
  it('top bar Settings opens it on the first project; saving sends only the changed fields', async () => {
    const { api, c } = await setup();
    const update = vi.spyOn(api.projects, 'update');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(c.state.dialog).toEqual({ kind: 'settings', section: 'projects', projectId: SAMPLE.projects.agentdeck });
    const d = dialog();
    expect(within(d).getByRole('button', { name: 'agentdeck' }).getAttribute('aria-current')).toBe('page');
    expect((within(d).getByLabelText('Setup command') as HTMLInputElement).value).toBe('pnpm install');
    expect(within(d).getByText(SAMPLE.paths.agentdeck)).toBeTruthy();

    const save = within(d).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Base branch 的选项来自 git.branches
    await choose('Base branch', 'feat/login');
    fireEvent.change(within(d).getByLabelText('Files to copy'), { target: { value: '.env\n\n  config/local.json \n' } });
    fireEvent.change(within(d).getByLabelText('Setup command'), { target: { value: 'pnpm install --frozen-lockfile' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(c.state.dialog).toBeNull());
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(SAMPLE.projects.agentdeck, {
      baseBranch: { '.': 'feat/login' },
      copyIntoWorktrees: ['.env', 'config/local.json'],
      setupCommand: 'pnpm install --frozen-lockfile',
    });
    const project = c.state.projects.find((p) => p.id === SAMPLE.projects.agentdeck)!;
    expect(project.repos[0]!.baseBranch).toBe('feat/login');

    // 之后新建的 worktree 用新的基础分支、复制新的文件、跑新的初始化命令
    const addWorktree = vi.spyOn(api.fakes.git, 'addWorktree');
    const progress: string[] = [];
    api.on('workspace.progress', (e) => progress.push(e.message));
    const ws = await act(() => c.createWorkspace({ projectId: SAMPLE.projects.agentdeck, mode: 'worktree', branch: { kind: 'new', name: 'feat/oauth' } }, null));
    expect(ws).toBeTruthy();
    expect(addWorktree).toHaveBeenCalledWith(SAMPLE.paths.agentdeck, expect.any(String), { name: 'feat/oauth', create: true, from: 'feat/login' });
    expect(progress).toContain('Copying .env, config/local.json');
    expect(api.fakes.agents.started.at(-1)!.request).toMatchObject({ agent: 'shell', command: 'pnpm install --frozen-lockfile', workspaceId: ws });
  });

  it('a multi-repo project has a base branch per repo; changing the worktree location uses Browse…', async () => {
    const { api, c } = await setup();
    const update = vi.spyOn(api.projects, 'update');
    act(() => c.openSettings({ projectId: SAMPLE.projects.shop }));
    const d = dialog();
    expect(within(d).getByRole('button', { name: 'Base branch · api' })).toBeTruthy();
    expect(within(d).getByRole('button', { name: 'Base branch · web' })).toBeTruthy();
    api.fakes.app.queuePickFolder('/Volumes/fast/worktrees/shop' as AbsPath);
    fireEvent.click(within(d).getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect((within(d).getByLabelText('Worktree location') as HTMLInputElement).value).toBe('/Volumes/fast/worktrees/shop'));
    fireEvent.change(within(d).getByLabelText('Name'), { target: { value: 'shop-app' } });
    // 左边的名字跟着草稿变
    expect(within(d).getByRole('button', { name: 'shop-app' })).toBeTruthy();
    fireEvent.click(within(d).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(c.state.dialog).toBeNull());
    expect(update).toHaveBeenCalledWith(SAMPLE.projects.shop, { name: 'shop-app', worktreeRoot: '/Volumes/fast/worktrees/shop' });
  });

  it('edits on several pages are kept while switching and saved together; Cancel discards them', async () => {
    const { api, c } = await setup();
    const update = vi.spyOn(api.projects, 'update');
    const updateSettings = vi.spyOn(api.app, 'updateSettings');
    act(() => c.openSettings());
    fireEvent.change(within(dialog()).getByLabelText('Setup command'), { target: { value: '' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'General' }));
    expect(c.state.dialog).toEqual({ kind: 'settings', section: 'general' });
    const editor = (await within(dialog()).findByLabelText('Editor command')) as HTMLInputElement;
    fireEvent.change(editor, { target: { value: 'cursor -g' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'agentdeck' }));
    expect((within(dialog()).getByLabelText('Setup command') as HTMLInputElement).value).toBe('');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(c.state.dialog).toBeNull();
    expect(update).not.toHaveBeenCalled();

    act(() => c.openSettings());
    expect((within(dialog()).getByLabelText('Setup command') as HTMLInputElement).value).toBe('pnpm install');
    fireEvent.change(within(dialog()).getByLabelText('Setup command'), { target: { value: '' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'General' }));
    fireEvent.change(await within(dialog()).findByLabelText('Editor command'), { target: { value: 'cursor -g' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(c.state.dialog).toBeNull());
    expect(update).toHaveBeenCalledWith(SAMPLE.projects.agentdeck, { setupCommand: null });
    expect(updateSettings).toHaveBeenCalledWith({ editorCommand: 'cursor -g' });
  });

  it('General saves closeWindow, notifications, editor, terminal app and default agent with app.updateSettings', async () => {
    const { api, c } = await setup();
    const updateSettings = vi.spyOn(api.app, 'updateSettings');
    const before = await api.app.getSettings();
    act(() => c.openSettings({ section: 'general' }));
    const d = dialog();
    fireEvent.click(await within(d).findByRole('radio', { name: 'Quit AgentDeck' }));
    fireEvent.click(within(d).getByRole('checkbox'));
    fireEvent.change(within(d).getByLabelText('Editor command'), { target: { value: ' zed ' } });
    fireEvent.change(within(d).getByLabelText('Terminal app'), { target: { value: 'Ghostty' } });
    const codex = c.state.agents.find((a) => a.id === 'codex')!;
    expect(codex.installed).toBe(true);
    await choose('Default agent', codex.label);
    fireEvent.click(within(d).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(c.state.dialog).toBeNull());
    expect(updateSettings).toHaveBeenCalledWith({
      closeWindow: 'quit',
      notifications: !before.notifications,
      editorCommand: 'zed',
      terminalApp: 'Ghostty',
      defaultAgent: 'codex',
    });
    expect(await c.defaultAgent()).toBe('codex');
  });

  it('a failed save shows a toast and keeps the dialog open', async () => {
    const { api, c } = await setup();
    vi.spyOn(api.projects, 'update').mockRejectedValueOnce(new Error('Worktree location must be an absolute path'));
    act(() => c.openSettings());
    fireEvent.change(within(dialog()).getByLabelText('Worktree location'), { target: { value: 'worktrees' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Couldn’t save agentdeck: Worktree location must be an absolute path')).toBeTruthy();
    expect(c.state.dialog?.kind).toBe('settings');
    // 空的名字不能保存
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: '  ' } });
    expect((within(dialog()).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Open settings.json calls the host and closes the dialog', async () => {
    const onOpenSettingsFile = vi.fn();
    const { c } = await setup({ onOpenSettingsFile });
    act(() => c.openSettings());
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Open settings.json' }));
    expect(onOpenSettingsFile).toHaveBeenCalledTimes(1);
    expect(c.state.dialog).toBeNull();
  });

  it('without a host there is no Open settings.json button', async () => {
    const { c } = await setup();
    act(() => c.openSettings());
    expect(within(dialog()).queryByRole('button', { name: 'Open settings.json' })).toBeNull();
  });

  it('project menu › Project settings… opens it on that project', async () => {
    const { c } = await setup();
    // 一行顶栏（MVP v2 · V1）：项目菜单在左边，没有聚焦时按钮上写 My Board
    fireEvent.click(screen.getByRole('button', { name: 'My Board' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /shop/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Project settings…' }));
    expect(c.state.dialog).toEqual({ kind: 'settings', section: 'projects', projectId: SAMPLE.projects.shop });
    expect(within(dialog()).getByRole('button', { name: 'shop' }).getAttribute('aria-current')).toBe('page');
  });

  it('⌘, opens it, also from a text field', async () => {
    const { c } = await setup();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    fireEvent.keyDown(input, { key: ',', metaKey: true });
    expect(c.state.dialog?.kind).toBe('settings');
    act(() => c.closeDialog());
    input.remove();
    expect(c.runShortcut('open-settings')).toBe(true);
    expect(c.state.dialog).toEqual({ kind: 'settings', section: 'projects', projectId: SAMPLE.projects.agentdeck });
  });

  it('a missing project offers Locate…', async () => {
    const { api, c } = await setup();
    act(() => api.scenario.projectFolderMissing(SAMPLE.projects.shop));
    await waitFor(() => expect(c.state.projects.find((p) => p.id === SAMPLE.projects.shop)?.missing).toBe(true));
    act(() => c.openSettings({ projectId: SAMPLE.projects.shop }));
    const d = dialog();
    expect(within(d).getByText('Folder not found')).toBeTruthy();
    const locate = vi.spyOn(api.projects, 'locate').mockImplementation(async (id) => ({ ...c.state.projects.find((p) => p.id === id)!, missing: false }));
    api.fakes.app.queuePickFolder('/Users/you/code/shop' as AbsPath);
    fireEvent.click(within(d).getByRole('button', { name: 'Locate…' }));
    await waitFor(() => expect(locate).toHaveBeenCalledWith(SAMPLE.projects.shop, '/Users/you/code/shop'));
    await waitFor(() => expect(within(d).queryByText('Folder not found')).toBeNull());
  });
});

describe('settings drafts', () => {
  const project: Project = {
    id: SAMPLE.projects.agentdeck,
    name: 'agentdeck',
    kind: 'git',
    path: '/r' as AbsPath,
    repos: [{ name: '.', path: '/r' as AbsPath, baseBranch: 'main' }],
    worktreeRoot: '/w' as AbsPath,
    copyIntoWorktrees: ['.env', '.env.local'],
    setupCommand: null,
    missing: false,
    lastUsedAt: '2026-10-24T00:00:00.000Z',
  };

  it('an untouched draft is no patch; whitespace and blank lines are ignored', () => {
    const d = projectDraft(project);
    expect(projectPatch(project, d)).toEqual({});
    expect(projectPatch(project, { ...d, name: ' agentdeck ', copy: '.env\n\n .env.local \n', setup: '   ' })).toEqual({});
    expect(parseLines(' a \n\nb')).toEqual(['a', 'b']);
  });

  it('changed fields only', () => {
    const d = projectDraft(project);
    expect(projectPatch(project, { ...d, copy: '', setup: 'make', baseBranch: { '.': 'develop' } })).toEqual({
      copyIntoWorktrees: [],
      setupCommand: 'make',
      baseBranch: { '.': 'develop' },
    });
    expect(projectDraftError({ ...d, name: '' }, 'git')).toBe('name');
    expect(projectDraftError({ ...d, worktreeRoot: ' ' }, 'git')).toBe('worktreeRoot');
    expect(projectDraftError({ ...d, worktreeRoot: '' }, 'plain')).toBeNull();
  });

  it('general patch', async () => {
    const s = await createFakeApi().app.getSettings();
    const d = generalDraft(s);
    expect(generalPatch(s, d)).toEqual({});
    expect(generalPatch(s, { ...d, terminalApp: ' iTerm ' })).toEqual({ terminalApp: 'iTerm' });
  });
});
