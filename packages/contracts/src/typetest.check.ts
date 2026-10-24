// 只用于类型检查：确认接口能被实现、事件能按 type 收窄。不会被打包。
import type { AgentDeckApi, CommitInfo, EventOf, GitService, LogOptions, TerminalHost, TerminalId } from './index.ts';
import { FIRE_AND_FORGET } from './index.ts';

declare const api: AgentDeckApi;
api.on('status.changed', (e) => {
  const s: string = e.snapshot.status;
  void s;
});
api.on('terminal.link', (e: EventOf<'terminal.link'>) => {
  if (e.link.kind === 'file') void e.link.path;
});
api.on('board.open-window', (e: EventOf<'board.open-window'>) => {
  const t: string = e.request.type;
  void t;
});
const fakeLastLines: TerminalHost['lastLines'] = async (_id: TerminalId, n: number) => Array.from({ length: n }, () => '');
const fakeStatus: GitService['status'] = async (repo) => ({
  repo, branch: 'main', head: null, upstream: null, ahead: 0, behind: 0, aheadOfBase: 0, baseBranch: 'main',
  operation: 'none', files: [], at: new Date().toISOString(),
});
// N5：提交图的字段都是可选的；只认 StatusOptions 的旧 log 实现仍然能当 GitService['log'] 用
const oldLog = async (_repo: string, _limit: number, _opts?: { baseBranch?: string }): Promise<CommitInfo[]> => [];
const graphLog: GitService['log'] = oldLog;
const graphOpts: LogOptions = { baseBranch: 'main', graph: { branches: ['feat/login', 'main'] } };
const oneCommit: LogOptions = { commit: 'abc1234' };
const graphCommit: CommitInfo = {
  hash: 'b', shortHash: 'b', subject: 'Merge', author: 'a', at: '', onBase: true, parents: ['a', 'c'],
  refs: [{ name: 'main', kind: 'branch', current: true }, { name: 'origin/main', kind: 'remote' }, { name: 'HEAD', kind: 'head' }],
  files: [{ path: 'src/a.ts', fromPath: null, kind: 'modified' }],
};
const merged: Promise<boolean | undefined> = api.git.branches('/r', { mergedInto: 'main' }).then((b) => b[0]?.merged);
void graphLog; void graphOpts; void oneCommit; void graphCommit; void merged;
void fakeLastLines; void fakeStatus; void FIRE_AND_FORGET.terminals;
