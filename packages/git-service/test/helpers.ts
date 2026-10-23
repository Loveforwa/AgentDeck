import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AbsPath, GitEvent } from '@agentdeck/contracts';
import { createGitService, type GitServiceOptions } from '../src/index.ts';

/** 不读用户的全局配置（签名、钩子路径、别名都不影响测试）。 */
export const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'AgentDeck Test',
  GIT_AUTHOR_EMAIL: 'test@agentdeck.invalid',
  GIT_COMMITTER_NAME: 'AgentDeck Test',
  GIT_COMMITTER_EMAIL: 'test@agentdeck.invalid',
};

export function makeGit(extra: Partial<GitServiceOptions> = {}) {
  const trashed: AbsPath[] = [];
  const events: GitEvent[] = [];
  const git = createGitService({
    env: TEST_ENV,
    moveToTrash: async (p) => {
      trashed.push(p);
      const { rmSync } = await import('node:fs');
      rmSync(p, { recursive: true, force: true });
    },
    emit: (e) => events.push(e),
    ...extra,
  });
  return { git, trashed, events };
}

export function tempDir(prefix = 'agentdeck-git-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
