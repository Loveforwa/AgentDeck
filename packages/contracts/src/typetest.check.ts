// 只用于类型检查：确认接口能被实现、事件能按 type 收窄。不会被打包。
import type { AgentDeckApi, EventOf, GitService, TerminalHost, TerminalId } from './index.ts';
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
void fakeLastLines; void fakeStatus; void FIRE_AND_FORGET.terminals;
