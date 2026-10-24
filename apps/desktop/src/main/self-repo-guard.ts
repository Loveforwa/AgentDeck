// Q39：AgentDeck 自己可能就是从一个 git 仓库里运行的（开发时 pnpm dev 跑在 agenduck 仓库里）。
// 在白板上把这个目录切到别的分支，等于把正在运行的应用的代码换掉，开发服务器会立刻加载旧代码，界面直接坏掉；
// 把它当工作区连目录一起删，更是删掉应用自己。所以这两种操作对“应用自己运行的目录”一律拒绝。
// 打包后的应用在 .app 里运行，不在任何仓库里，selfRoot 为 null，这里什么都不拦。

import { realpathSync } from 'node:fs';
import { AgentDeckError, type AbsPath, type GitService, type WorkspaceService } from '@agentdeck/contracts';

export const SELF_SWITCH_MESSAGE =
  'AgentDeck is running from this folder, so switching its branch would replace the app while it runs. Open that branch in a new workspace instead.';
export const SELF_DELETE_MESSAGE = 'AgentDeck is running from this folder, so it can’t be deleted from here. Remove the workspace from the board instead.';

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, '');
  }
}

function refused(message: string, selfRoot: AbsPath): Promise<never> {
  return Promise.reject(new AgentDeckError({ code: 'unsupported', message, detail: `AgentDeck runs from ${selfRoot}` }));
}

/** 判断一个目录是不是应用自己运行的那个 worktree。 */
export function isSelfFolder(selfRoot: AbsPath | null, dir: AbsPath): boolean {
  return selfRoot !== null && canonical(dir) === canonical(selfRoot);
}

/** 包一层 GitService：对应用自己运行的目录，拒绝 switchBranch 和“建分支并切过去”。其余方法原样转发。 */
export function guardGitService(git: GitService, selfRoot: AbsPath | null): GitService {
  if (selfRoot === null) return git;
  return new Proxy(git, {
    get(target, prop, receiver) {
      if (prop === 'switchBranch') {
        return (repo: AbsPath, branch: string, strategy: Parameters<GitService['switchBranch']>[2]) =>
          isSelfFolder(selfRoot, repo) ? refused(SELF_SWITCH_MESSAGE, selfRoot) : target.switchBranch(repo, branch, strategy);
      }
      if (prop === 'createBranch') {
        return (repo: AbsPath, name: string, opts: Parameters<GitService['createBranch']>[2]) =>
          opts.switchTo && isSelfFolder(selfRoot, repo) ? refused(SELF_SWITCH_MESSAGE, selfRoot) : target.createBranch(repo, name, opts);
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** 包一层 WorkspaceService：应用自己运行的目录不能“连目录一起删”。只从白板移除照常可以。 */
export function guardWorkspaceService(workspaces: WorkspaceService, selfRoot: AbsPath | null): WorkspaceService {
  if (selfRoot === null) return workspaces;
  return new Proxy(workspaces, {
    get(target, prop, receiver) {
      if (prop === 'remove') {
        return async (req: Parameters<WorkspaceService['remove']>[0]) => {
          if (req.deleteFolder) {
            const ws = (await target.list()).find((w) => w.id === req.id);
            if (ws && (isSelfFolder(selfRoot, ws.path) || ws.repos.some((r) => isSelfFolder(selfRoot, r.path)))) {
              return refused(SELF_DELETE_MESSAGE, selfRoot);
            }
          }
          return target.remove(req);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
