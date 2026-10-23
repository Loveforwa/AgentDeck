import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempRepo } from '../src/temp-repo.ts';
import type { TempRepo } from '../src/temp-repo.ts';

const repos: TempRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

describe('createTempRepo', () => {
  it('builds main with commits and a feature branch', async () => {
    const repo = await createTempRepo();
    repos.push(repo);
    expect(repo.git('branch', '--show-current')).toBe('main');
    expect(repo.git('log', '--format=%s', 'main').split('\n')).toEqual([
      'Add package.json',
      'Add entry point',
      'Initial commit',
    ]);
    expect(repo.git('log', '--format=%s', 'main..feature/login')).toBe('Add login form');
    expect(repo.git('status', '--porcelain')).toBe('');
    expect(repo.git('rev-parse', '--show-toplevel')).toBe(repo.path);
  });

  it('supports dirty state, a remote and worktrees', async () => {
    const repo = await createTempRepo({ dirty: true, withRemote: true, branches: [] });
    repos.push(repo);
    expect(repo.git('status', '--porcelain=v1').split('\n').sort()).toEqual([
      ' M README.md',
      '?? notes.txt',
      'A  src/new-file.ts',
    ]);
    expect(repo.git('rev-parse', '--abbrev-ref', 'origin/HEAD')).toBe('origin/main');
    repo.commit('Local work');
    expect(repo.git('rev-list', '--count', 'origin/main..main')).toBe('1');

    const wt = repo.addWorktree('feat/x', { create: true });
    expect(repo.git('worktree', 'list', '--porcelain')).toContain(`worktree ${wt}`);
    const root = repo.path;
    repo.cleanup();
    repos.pop();
    expect(existsSync(root)).toBe(false);
  });

  it('accepts custom commits', async () => {
    const repo = await createTempRepo({ defaultBranch: 'trunk', commits: [{ subject: 'One', files: { 'a.txt': 'a' } }, 'Two'] });
    repos.push(repo);
    expect(repo.git('log', '--format=%s').split('\n')).toEqual(['Two', 'One']);
    expect(repo.git('branch', '--show-current')).toBe('trunk');
  });
});
