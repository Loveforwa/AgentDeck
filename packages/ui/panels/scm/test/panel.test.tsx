import type { GitService, WorkspaceId } from '@agentdeck/contracts';
import { SAMPLE, createFakeApi, type FakeApi } from '@agentdeck/fakes';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScmPanel, type ScmApi } from '../src/index.ts';

const W = SAMPLE.workspaces;
const P = SAMPLE.paths;

/** 假 API，外加：数 git.status 调用次数，可选地让每次 git 调用慢一点。 */
function setup(opts: { slowMs?: number } = {}) {
  const fake: FakeApi = createFakeApi();
  const calls = { status: 0 };
  const git = new Proxy(fake.git, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (prop === 'status') calls.status += 1;
        if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as GitService;
  const api: ScmApi = { ...fake, git };
  return { fake, api, calls };
}

beforeEach(() => {
  localStorage.clear();
});

async function ready(name: RegExp | string = /Commit/) {
  await screen.findByRole('button', { name });
}

describe('ScmPanel', () => {
  it('says so when the focused window is not in a workspace', () => {
    const { api } = setup();
    render(<ScmPanel api={api} workspaceId={null} />);
    expect(screen.getByText('This window isn’t in a workspace.')).toBeTruthy();
  });

  it('shows the workspace, branch and changes as a folder tree', async () => {
    const { api } = setup();
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    await ready('Commit 1 file');
    expect(screen.getByText('agentdeck · feat/login')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Branch feat\/login/ })).toBeTruthy();
    const staged = screen.getByRole('region', { name: 'Staged Changes' });
    expect(within(staged).getByText('src')).toBeTruthy();
    expect(within(staged).getByText('App.tsx')).toBeTruthy();
    const changes = screen.getByRole('region', { name: 'Changes' });
    expect(within(changes).getByText('Login.tsx')).toBeTruthy();
    expect(within(changes).getByText('login.test.ts')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Commits' })).toBeTruthy();
    expect(screen.getByText('On main')).toBeTruthy();
  });

  it('stages with +, commits with ⌘↩, and refreshes once per action', async () => {
    const user = userEvent.setup();
    const { api, calls, fake } = setup();
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    await ready('Commit 1 file');
    const before = calls.status;

    await user.click(screen.getByRole('button', { name: 'Stage Login.tsx' }));
    await ready('Commit 2 files');
    expect(calls.status).toBe(before + 1);

    const box = screen.getByRole('textbox', { name: 'Commit message' });
    expect((screen.getByRole('button', { name: 'Commit 2 files' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(box, 'feat: login form');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(screen.getByText('feat: login form')).toBeTruthy());
    expect((box as HTMLTextAreaElement).value).toBe('');
    expect(calls.status).toBe(before + 2);
    const log = await fake.git.log(P.agentdeckLogin, 1);
    expect(log[0]?.subject).toBe('feat: login form');
  });

  it('refreshes only when the workspace changes, its agent finishes a turn, or on Refresh', async () => {
    const user = userEvent.setup();
    const { api, calls, fake } = setup();
    const { rerender } = render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    await ready();
    await waitFor(() => expect(calls.status).toBe(1));

    // 别的工作区的 agent 一轮结束：不刷新
    act(() => fake.scenario.agentTurnEnd(SAMPLE.terminals.shopClaude));
    // 这个工作区的：刷新
    act(() => fake.scenario.agentTurnEnd(SAMPLE.terminals.loginClaude));
    await waitFor(() => expect(calls.status).toBe(2));

    rerender(<ScmPanel api={api} workspaceId={W.agentdeckMain} />);
    await waitFor(() => expect(calls.status).toBe(3));
    rerender(<ScmPanel api={api} workspaceId={W.agentdeckMain} runningAgents={['claude']} />);

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls.status).toBe(4));

    // 外面推来的 git.status 直接用，不再查一次
    act(() => fake.scenario.gitChanged(P.agentdeck, [{ path: 'outside.txt', unstaged: 'untracked' }]));
    await screen.findByText('outside.txt');
    expect(calls.status).toBe(4);
  });

  it('shows Refreshing… when git takes more than a second', async () => {
    const { api } = setup({ slowMs: 1300 });
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    await screen.findByText('Refreshing…', undefined, { timeout: 1500 });
    await waitFor(() => expect(screen.queryByText('Refreshing…')).toBeNull(), { timeout: 2500 });
  });

  it('greys out branches used by other workspaces and jumps there', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const goTo = vi.fn<(id: WorkspaceId) => void>();
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} onGoToWorkspace={goTo} />);
    await ready();
    await user.click(screen.getByRole('button', { name: /Branch feat\/login/ }));
    const main = await screen.findByRole('option', { name: /main.*in main folder/ });
    expect(main.getAttribute('data-occupied')).not.toBeNull();
    await user.click(main);
    expect(goTo).toHaveBeenCalledWith(W.agentdeckMain);
  });

  it('asks before switching with changes, stashes, and offers to restore on the way back', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} runningAgents={['claude']} />);
    await ready();

    // 新建一个分支，带着改动切过去
    await user.click(screen.getByRole('button', { name: /Branch feat\/login/ }));
    await user.click(await screen.findByRole('option', { name: 'New branch…' }));
    await user.type(screen.getByPlaceholderText('feat/my-change'), 'feat/other{Enter}');
    await screen.findByRole('button', { name: /Branch feat\/other/ });

    await user.click(screen.getByRole('button', { name: /Branch feat\/other/ }));
    await user.click(await screen.findByRole('option', { name: 'feat/login' }));
    const dialog = await screen.findByRole('dialog', { name: '3 uncommitted changes' });
    expect(within(dialog).getByText(/claude is running in this folder/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Stash and switch' }));
    await screen.findByRole('button', { name: /Branch feat\/login/ });
    expect(screen.getByText('No changes')).toBeTruthy();

    // 切回 feat/other：干净的，直接切；提示恢复
    await user.click(screen.getByRole('button', { name: /Branch feat\/login/ }));
    await user.click(await screen.findByRole('option', { name: 'feat/other' }));
    await screen.findByRole('dialog', { name: 'Switch to feat/other?' });
    await user.click(screen.getByRole('button', { name: 'Switch' }));
    await screen.findByText(/Changes stashed when you left feat\/other/);
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await ready('Commit 1 file');
    expect(screen.queryByText(/Changes stashed/)).toBeNull();
  });

  it('confirms the first Commit all, then remembers', async () => {
    const user = userEvent.setup();
    const { api, fake } = setup();
    render(<ScmPanel api={api} workspaceId={W.shopCart} />);
    await ready('Commit 1 change in 1 repo');
    expect(screen.getByRole('region', { name: 'api' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'web' })).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Commit message' }), 'fix: cart');
    await user.click(screen.getByRole('button', { name: 'Commit 1 change in 1 repo' }));
    await user.click(await screen.findByRole('button', { name: 'Commit all' }));
    await ready('Commit');
    expect((await fake.git.log(`${P.shopCart}/web`, 1))[0]?.subject).toBe('fix: cart');

    act(() => fake.scenario.gitChanged(`${P.shopCart}/api`, [{ path: 'b.ts', unstaged: 'modified' }]));
    await ready('Commit 1 change in 1 repo');
    await user.type(screen.getByRole('textbox', { name: 'Commit message' }), 'chore: b');
    await user.click(screen.getByRole('button', { name: 'Commit 1 change in 1 repo' }));
    await waitFor(async () => expect((await fake.git.log(`${P.shopCart}/api`, 1))[0]?.subject).toBe('chore: b'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before discarding and moves untracked files to the trash', async () => {
    const user = userEvent.setup();
    const { api, fake } = setup();
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    await ready();
    await user.click(screen.getByRole('button', { name: 'Discard changes to login.test.ts' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move login.test.ts to Trash?' });
    await user.click(within(dialog).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(screen.queryByText('login.test.ts')).toBeNull());
    expect(fake.fakes.git.trashed).toEqual([`${P.agentdeckLogin}/src/login.test.ts`]);
  });

  it('shows a read-only diff and goes back', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    await ready();
    await user.click(screen.getByRole('button', { name: 'Login.tsx' }));
    expect(await screen.findByRole('button', { name: 'Open in editor' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back to changes' }));
    await ready();
  });

  it('shows Merging with conflicts on top', async () => {
    const { api, fake } = setup();
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    await ready();
    act(() => {
      fake.fakes.git.addChanges(P.agentdeckLogin, { path: 'src/x.ts', staged: 'modified', unstaged: 'modified', conflicted: true });
      fake.fakes.git.setOperation(P.agentdeckLogin, 'merge');
    });
    await screen.findByText('Merging');
    const groups = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(groups.slice(0, 3)).toEqual(['Merge Changes', 'Staged Changes', 'Changes']);
    expect((screen.getByRole('button', { name: 'Complete merge' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers Initialize Repository for a folder without git', async () => {
    const user = userEvent.setup();
    const { api, fake } = setup();
    const [p] = await fake.projects.add({ folder: P.notes, as: 'plain' });
    const { workspace } = await fake.workspaces.create({ projectId: p!.id, mode: 'main-folder' });
    render(<ScmPanel api={api} workspaceId={workspace.id} />);
    expect(await screen.findByText('notes isn’t a Git repository.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Initialize Repository' }));
    await screen.findByRole('button', { name: /Branch main/ });
    expect(screen.getByText('No changes')).toBeTruthy();
  });
});
