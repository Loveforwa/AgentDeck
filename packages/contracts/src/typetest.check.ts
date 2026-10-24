// 只用于类型检查：确认接口能被实现、事件能按 type 收窄。不会被打包。
import type {
  AgentDeckApi, ApproveResult, AutoApproveState, CommitInfo, EventOf, GitService, LogOptions, SkillItemId, TerminalHost, TerminalId,
  TerminalSkills, TerminalUsage, TerminalWindowData, UsageService, WindowGroupId, WindowId, WindowNode, WorkspaceId,
} from './index.ts';
import { effectiveSkillSelection, FIRE_AND_FORGET, isAutoApproveOn, skillsRestartNeeded } from './index.ts';

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
// PL1：Auto-approve 的开关、事件、Approve all 的选项。
api.on('approval.auto-approve-changed', (e) => {
  const on: boolean = isAutoApproveOn(e.state, 't1' as TerminalId, 'w1' as WorkspaceId);
  void on;
});
api.on('approval.needs-you', (e) => {
  if (e.reason === 'couldnt-approve' || e.reason === 'destructive') void e.request?.summary;
});
void api.approvals.autoApproveNeedsYou().then((xs) => xs.map((x) => [x.terminalId, x.reason]));
void api.approvals.approve([], { by: 'approve-all', includeDestructive: false }).then((rs: ApproveResult[]) => {
  for (const r of rs) if (!r.ok && r.reason === 'destructive') void r.id;
});
void api.approvals.setTerminalAutoApprove('t1' as TerminalId, null);
void api.approvals.autoApproveSupport().then((s) => s.map((x) => x.method));
const emptyState: AutoApproveState = { workspaces: [], terminals: [] };
void emptyState;
// PL2：终端的 token 用量。
api.on('usage.changed', (e: EventOf<'usage.changed'>) => {
  const u: TerminalUsage = e.usage;
  if (u.state === 'ok' && u.context?.percent != null) void u.context.percent.toFixed(0);
  if (u.rateLimits?.primary) void u.rateLimits.primary.usedPercent;
});
const noUsage: UsageService['get'] = async (terminalId) => ({
  terminalId, agent: null, state: 'unsupported', reason: 'Not an agent', sessionId: null, match: null, file: null,
  model: null, total: null, last: null, requests: 0, context: null, rateLimits: null, updatedAt: null,
});
void noUsage; void api.usage.watch;
// N9：Skills · MCP。选择随白板保存在 TerminalWindowData.skills。
void api.skills.forTerminal('t1' as TerminalId).then((s: TerminalSkills) => {
  const chosen: SkillItemId[] = effectiveSkillSelection(s.items, null);
  const restart: boolean = skillsRestartNeeded(s.items, chosen, s.running);
  void restart;
});
void api.skills.addMcp({ name: 'github', command: 'npx -y @modelcontextprotocol/server-github' }).then((i) => i.kind === 'mcp');
api.on('skills.library-changed', (e) => void e.items.map((i) => i.source));
const termData: TerminalWindowData = {
  terminalId: null, agent: 'claude', cmd: 'claude', args: [], cwd: '/r', sessionId: null, startCommand: null, skills: ['skill:library:xlsx'],
};
void termData;
