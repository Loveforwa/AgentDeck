// Q39：应用自己运行的目录不能在界面里切分支、不能连目录删掉。
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitService, Workspace, WorkspaceId, WorkspaceService } from '@agentdeck/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF_DELETE_MESSAGE, SELF_SWITCH_MESSAGE, guardGitService, guardWorkspaceService, isSelfFolder } from '../src/main/self-repo-guard.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentdeck-guard-'));
  dirs.push(d);
  return d;
}

function fakeGit() {
  const calls: string[] = [];
  const git = {
    switchBranch: vi.fn(async (repo: string, branch: string) => void calls.push(`switch ${repo} ${branch}`)),
    createBranch: vi.fn(async (repo: string, name: string) => void calls.push(`create ${repo} ${name}`)),
    status: vi.fn(async () => ({ ok: true })),
  } as unknown as GitService;
  return { git, calls };
}

describe('guardGitService', () => {
  it('refuses to switch the folder AgentDeck runs from, and passes everything else through', async () => {
    const self = tmp();
    const other = tmp();
    const { git, calls } = fakeGit();
    const guarded = guardGitService(git, self);

    await expect(guarded.switchBranch(self, 'old', 'carry')).rejects.toMatchObject({ code: 'unsupported', message: SELF_SWITCH_MESSAGE });
    await expect(guarded.switchBranch(`${self}/`, 'old', 'carry')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(guarded.createBranch(self, 'feat/x', { switchTo: true })).rejects.toMatchObject({ code: 'unsupported' });

    await guarded.createBranch(self, 'feat/y', { switchTo: false }); // 只建不切：可以
    await guarded.switchBranch(other, 'main', 'carry'); // 别的目录：可以
    await guarded.status(other);
    expect(calls).toEqual([`create ${self} feat/y`, `switch ${other} main`]);
  });

  it('sees through symlinks to the same folder', async () => {
    const self = tmp();
    const link = join(tmp(), 'link');
    symlinkSync(self, link);
    expect(isSelfFolder(self, link)).toBe(true);
    const { git } = fakeGit();
    await expect(guardGitService(git, self).switchBranch(link, 'old', 'carry')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('does nothing when AgentDeck is not running from a git checkout (packaged app)', async () => {
    const { git, calls } = fakeGit();
    const guarded = guardGitService(git, null);
    expect(guarded).toBe(git);
    await guarded.switchBranch('/any', 'main', 'carry');
    expect(calls).toEqual(['switch /any main']);
  });
});

describe('guardWorkspaceService', () => {
  function fakeWorkspaces(list: Workspace[]) {
    const removed: string[] = [];
    const ws = {
      list: vi.fn(async () => list),
      remove: vi.fn(async (req: { id: WorkspaceId; deleteFolder: boolean }) => void removed.push(`${req.id}:${req.deleteFolder}`)),
    } as unknown as WorkspaceService;
    return { ws, removed };
  }
  const w = (id: string, path: string): Workspace =>
    ({ id: id as WorkspaceId, path, repos: [{ name: '.', path, branch: 'main' }] }) as unknown as Workspace;

  it('refuses to delete the folder AgentDeck runs from, but still lets it leave the board', async () => {
    const self = tmp();
    const other = tmp();
    const { ws, removed } = fakeWorkspaces([w('self', self), w('other', other)]);
    const guarded = guardWorkspaceService(ws, self);

    await expect(guarded.remove({ id: 'self' as WorkspaceId, deleteFolder: true })).rejects.toMatchObject({
      code: 'unsupported',
      message: SELF_DELETE_MESSAGE,
    });
    await guarded.remove({ id: 'self' as WorkspaceId, deleteFolder: false });
    await guarded.remove({ id: 'other' as WorkspaceId, deleteFolder: true });
    expect(removed).toEqual(['self:false', 'other:true']);
  });
});
