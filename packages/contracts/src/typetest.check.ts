// 只用于类型检查：确认接口能被实现、事件能按 type 收窄。不会被打包。
import type { AgentDeckApi, EventOf, GitService, TerminalHost, TerminalId, WindowGroupId, WindowId, WindowNode } from './index.ts';
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
// N1：窗口组和服务让白板做的新事
api.on('board.open-group', (e: EventOf<'board.open-group'>) => {
  const lead: TerminalId | null = e.lead;
  const labels: (string | null)[] = e.members.map((m) => m.label);
  void lead; void labels;
});
api.on('board.focus-window', (e) => {
  if ('terminalId' in e.target) void e.target.terminalId;
  else void e.target.windowId;
});
api.on('board.notify', (e) => void e.message);
api.on('board.open-window', (e) => void e.nearTerminal);
const grouped: WindowNode = {
  id: 'w' as WindowId, type: 'terminal', workspaceId: null, rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, title: null, restoreRect: null, data: {},
  group: { id: 'g' as WindowGroupId, role: 'member', label: 'api' },
};
void grouped;
const fakeLastLines: TerminalHost['lastLines'] = async (_id: TerminalId, n: number) => Array.from({ length: n }, () => '');
const fakeStatus: GitService['status'] = async (repo) => ({
  repo, branch: 'main', head: null, upstream: null, ahead: 0, behind: 0, aheadOfBase: 0, baseBranch: 'main',
  operation: 'none', files: [], at: new Date().toISOString(),
});
void fakeLastLines; void fakeStatus; void FIRE_AND_FORGET.terminals;
