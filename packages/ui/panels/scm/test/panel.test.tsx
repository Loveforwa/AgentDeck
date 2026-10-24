import type { CommitInfo, GitService, LogOptions, WorkspaceId } from '@agentdeck/contracts';
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

  it('puts headerActions (the board’s Collapse panel button) right after Refresh (MVP v2 · V4)', () => {
    const { api } = setup();
    render(<ScmPanel api={api} workspaceId={null} headerActions={<button type="button">Collapse panel</button>} />);
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    expect(refresh.nextElementSibling).toBe(screen.getByRole('button', { name: 'Collapse panel' }));
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
    // 假实现的 log 没有 parents / refs：提交图画成一条直线，HEAD 那条补上当前分支
    const graph = screen.getByRole('region', { name: 'Commit graph' });
    expect(within(graph).getByText('HEAD → feat/login')).toBeTruthy();
    expect(within(graph).getByText('Add login form')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Repository' })).toBeNull();
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
    expect(within(dialog).getByText(/claude is open in this folder/)).toBeTruthy();
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

  it('asks before switching a clean folder when any terminal is open there, even an idle shell (Q38)', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const { rerender } = render(<ScmPanel api={api} workspaceId={W.agentdeckMain} openTerminals={['zsh']} />);
    await ready();
    // 新建一个分支并切过去，好让 main 空出来可以切回
    await user.click(screen.getByRole('button', { name: /Branch main/ }));
    await user.click(await screen.findByRole('option', { name: 'New branch…' }));
    await user.type(screen.getByPlaceholderText('feat/my-change'), 'feat/q38{Enter}');
    await screen.findByRole('button', { name: /Branch feat\/q38/ });

    // 没有改动，但目录里开着一个空闲的 zsh：先确认，取消就不切
    await user.click(screen.getByRole('button', { name: /Branch feat\/q38/ }));
    await user.click(await screen.findByRole('option', { name: 'main' }));
    const dialog = await screen.findByRole('dialog', { name: 'Switch to main?' });
    expect(within(dialog).getByText(/zsh is open in this folder/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: /Branch feat\/q38/ })).toBeTruthy();

    // 目录里没有任何终端：直接切
    rerender(<ScmPanel api={api} workspaceId={W.agentdeckMain} openTerminals={[]} />);
    await user.click(screen.getByRole('button', { name: /Branch feat\/q38/ }));
    await user.click(await screen.findByRole('option', { name: 'main' }));
    await screen.findByRole('button', { name: /Branch main/ });
    expect(screen.queryByRole('dialog')).toBeNull();
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

// ---- 提交图（N5） ----

/**
 * 假实现的 log 不认 graph / commit，这里换成一张手写的图：
 * feat/login（HEAD）从 b3 分出；main 上合并过 feat/old；spike 没合并、不在白板上；还有两个已合并的旧分支不在这一窗里。
 */
async function graphSetup() {
  const base = setup();
  const head = (await base.fake.git.status(P.agentdeckLogin)).head ?? 'head';
  const at = (m: number) => new Date(Date.parse('2026-10-20T09:00:00Z') - m * 60_000).toISOString();
  const commit = (hash: string, subject: string, parents: string[], refs: CommitInfo['refs'] = [], m = 0): CommitInfo => ({
    hash,
    shortHash: hash.slice(0, 7),
    subject,
    author: 'Ann',
    at: at(m),
    onBase: false,
    parents,
    refs,
  });
  const graph: CommitInfo[] = [
    commit(head, 'Add login form', ['l1'], [{ name: 'feat/login', kind: 'branch', current: true }], 0),
    commit('mmmmmmm1', 'Merge feat/old', ['b3', 'o1'], [{ name: 'main', kind: 'branch' }, { name: 'origin/main', kind: 'remote' }], 1),
    commit('o1', 'Old work', ['b3'], [{ name: 'feat/old', kind: 'branch' }], 2),
    commit('s1', 'Abandoned spike', ['b3'], [{ name: 'spike', kind: 'branch' }], 3),
    commit('l1', 'Add login route', ['b3'], [], 4),
    commit('b3', 'Add board canvas', ['b2'], [{ name: 'v1', kind: 'tag' }], 5),
    commit('b2', 'Initial commit', [], [], 6),
  ];
  const calls: LogOptions[] = [];
  const merged: Record<string, boolean> = { main: true, 'feat/login': false, 'feat/old': true, spike: false, 'old/a': true, 'old/b': true };
  const git = new Proxy(base.api.git, {
    get(target, prop, receiver) {
      if (prop === 'log')
        return async (repo: string, limit: number, opts?: LogOptions) => {
          if (repo !== P.agentdeckLogin || (!opts?.graph && !opts?.commit)) return target.log(repo, limit, opts);
          calls.push(opts);
          if (opts.commit === 'o1')
            return [{ ...graph[2]!, files: [{ path: 'src/old/thing.ts', fromPath: null, kind: 'modified' }, { path: 'README.md', fromPath: null, kind: 'added' }] }];
          if (opts.commit) return [graph.find((c) => c.hash === opts.commit)!];
          return opts.graph?.branches ? graph.filter((c) => c.hash !== 's1' && c.hash !== 'o1') : graph;
        };
      if (prop === 'branches')
        return async (repo: string, opts?: { mergedInto?: string }) => {
          const list = await target.branches(repo);
          const names = new Set(list.map((b) => b.name));
          const extra = Object.keys(merged)
            .filter((n) => !names.has(n))
            .map((name) => ({ name, current: false, checkedOutAt: null, lastCommitAt: null }));
          return [...list, ...extra].map((b) => (opts?.mergedInto ? { ...b, merged: merged[b.name] ?? false } : b));
        };
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as GitService;
  return { ...base, api: { ...base.api, git } as ScmApi, calls, head };
}

describe('commit graph (N5)', () => {
  it('draws lanes with merge and fork arcs, labels branches, and highlights frames on the board', async () => {
    const user = userEvent.setup();
    const { api } = await graphSetup();
    const goTo = vi.fn<(id: WorkspaceId) => void>();
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} onGoToWorkspace={goTo} />);
    const graph = await screen.findByRole('region', { name: 'Commit graph' });
    await within(graph).findByText('Merge feat/old');
    const rows = within(graph).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.scm-graph-subject')?.textContent)).toEqual([
      'Add login form',
      'Merge feat/old',
      'Old work',
      'Abandoned spike',
      'Add login route',
      'Add board canvas',
      'Initial commit',
    ]);
    // HEAD 是实心点，合并提交是空心双圈；有分叉、合并的弧线（C 曲线）
    expect(rows[0]!.querySelector('[data-head]')).not.toBeNull();
    expect(rows[1]!.querySelectorAll('circle')).toHaveLength(2);
    expect([...graph.querySelectorAll('.scm-graph-line')].some((p) => p.getAttribute('d')?.includes('C'))).toBe(true);
    // 颜色只用档位（墨黑和灰），不写颜色值
    expect(rows[0]!.querySelector('[data-head]')?.getAttribute('data-tone')).toBe('0');
    expect(graph.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);

    expect(within(rows[0]!).getByText('HEAD → feat/login')).toBeTruthy();
    // 框名和分支名一样时只写 ◧
    expect(within(rows[0]!).getByText('◧')).toBeTruthy();
    expect(within(rows[1]!).getByText('◧ main folder')).toBeTruthy();
    // main 在白板上（主目录）：带 ◧，单击跳过去；origin/main 和本地 main 在同一个提交上，不重复
    await user.click(within(rows[1]!).getByRole('button', { name: /^main/ }));
    expect(goTo).toHaveBeenCalledWith(W.agentdeckMain);
    expect(within(rows[1]!).queryByText('origin/main')).toBeNull();
    expect(within(rows[3]!).getByText('spike').closest('[data-board]')).toBeNull();
    expect(within(rows[5]!).getByText('v1')).toBeTruthy();
  });

  it('collapses merged branches that are not on the board into one row', async () => {
    const user = userEvent.setup();
    const { api } = await graphSetup();
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    const graph = await screen.findByRole('region', { name: 'Commit graph' });
    const toggle = await within(graph).findByRole('button', { name: /3 merged branches not on the board/ });
    expect(within(graph).queryByText('feat/old')).toBeNull();
    await user.click(toggle);
    const list = within(graph).getByRole('list', { name: 'Merged branches' });
    expect(within(list).getAllByRole('listitem').map((r) => r.textContent)).toEqual(['feat/old', 'old/a', 'old/b']);
    // 展开后图上也出现它们的标签
    expect(within(graph).getAllByText('feat/old').length).toBe(2);
    await user.click(within(graph).getByRole('button', { name: /merged branches not on the board/ }));
    expect(within(graph).queryByText('feat/old')).toBeNull();
  });

  it('shows the files of a commit inline when you click it', async () => {
    const user = userEvent.setup();
    const { api, calls } = await graphSetup();
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    const graph = await screen.findByRole('region', { name: 'Commit graph' });
    const row = await within(graph).findByRole('button', { name: /Old work/ });
    await user.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const files = await within(graph).findByLabelText('Files in o1');
    expect(await within(files).findByText('thing.ts')).toBeTruthy();
    expect(within(files).getByText('src/old')).toBeTruthy();
    expect(within(files).getByText('README.md')).toBeTruthy();
    expect(calls.some((c) => c.commit === 'o1')).toBe(true);
    await user.click(row);
    expect(within(graph).queryByLabelText('Files in o1')).toBeNull();
  });

  it('offers Checkout for a branch tip and Copy for every commit', async () => {
    const user = userEvent.setup();
    const { api } = await graphSetup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    const graph = await screen.findByRole('region', { name: 'Commit graph' });
    await within(graph).findByText('Abandoned spike');
    // 当前分支、被别的框检出的 main 都没有 Checkout；spike 有
    expect(within(graph).queryByRole('button', { name: 'Checkout feat/login' })).toBeNull();
    expect(within(graph).queryByRole('button', { name: 'Checkout main' })).toBeNull();
    await user.click(within(graph).getByRole('button', { name: 'Copy hash mmmmmmm' }));
    expect(writeText).toHaveBeenCalledWith('mmmmmmm1');
    expect(within(graph).getByText('Copied')).toBeTruthy();
    // 走面板原来的切分支流程：有改动先问
    await user.click(within(graph).getByRole('button', { name: 'Checkout spike' }));
    expect(await screen.findByRole('dialog', { name: '3 uncommitted changes' })).toBeTruthy();
  });

  it('switches between This workspace and All branches, and remembers the choice', async () => {
    const user = userEvent.setup();
    const { api, calls } = await graphSetup();
    const { unmount } = render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    const graph = await screen.findByRole('region', { name: 'Commit graph' });
    await within(graph).findByText('Abandoned spike');
    expect(calls.at(-1)?.graph).toEqual({});
    await user.click(within(graph).getByRole('button', { name: 'Show: All branches' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'This workspace' }));
    await waitFor(() => expect(within(graph).queryByText('Abandoned spike')).toBeNull());
    expect(calls.at(-1)?.graph).toEqual({ branches: [] });
    expect(within(graph).getByRole('button', { name: 'Show: This workspace' })).toBeTruthy();
    unmount();

    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    await screen.findByRole('button', { name: 'Show: This workspace' });
  });
});
