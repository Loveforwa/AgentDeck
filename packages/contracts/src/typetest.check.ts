// 只用于类型检查：确认接口能被实现、事件能按 type 收窄。不会被打包。
import type {
  AgentDeckApi, ApproveResult, BoardState, FrameArrange, PromptQueueSettings, UsageLimit, SessionSummary, BackgroundAgent, TerminalBackgroundAgents, TranscriptLine, AutoApproveState, CommitInfo, EventOf, GitService, LogOptions, SkillItemId, TerminalHost, TerminalId,
  TerminalSkills, TerminalUsage, TerminalWindowData, UsageService, WindowGroupId, WindowId, WindowNode, WindowRestoreSupport, WorkspaceId,
  LaunchPreset, ProjectPatch, Settings,
} from './index.ts';
import { effectiveSkillSelection, FIRE_AND_FORGET, isAutoApproveOn, skillsRestartNeeded, findInlineSecret, redactCommand } from './index.ts';

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
// N2：lead 上记着侧边栏的显示方式
const leadRef: NonNullable<WindowNode['group']> = { id: 'g' as WindowGroupId, role: 'lead', label: null, view: { mode: 'one', shown: 'w' as WindowId } };
void leadRef;
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

// PL2：用量条的设置随白板保存，是可选字段，老数据没有它
const strip: TerminalWindowData['usage'] = { on: true, position: 'bottom' };
void strip;
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

// X6：恢复上次会话。都是可选字段，老数据没有它们
const restoredData: TerminalWindowData = { ...termData, lastCommand: 'pnpm dev' };
void restoredData;
void api.agents.start({ agent: 'shell', cwd: '/r', workspaceId: null, mode: { kind: 'new' }, prefill: 'pnpm dev' });
void api.terminals.list().then((l) => l.map((t) => t.foregroundCommand ?? null));
const restoreSupport: WindowRestoreSupport<TerminalWindowData> = {
  describe: (d, live) => (d.terminalId && live.has(d.terminalId) ? null : { kind: 'shell', label: 'zsh', detail: 'Opens zsh', fresh: false }),
  restore: async () => ({ patch: { terminalId: 't2' as TerminalId }, fresh: false }),
};
void restoreSupport;
// N10：agent 自带的后台子 agent，只读。
api.on('subagents.changed', (e: EventOf<'subagents.changed'>) => {
  const a: BackgroundAgent | undefined = e.agents.agents[0];
  if (a?.state === 'running' && a.current) void a.description?.length;
});
api.on('subagents.transcript-changed', (e) => void e.transcript.lines.map((l: TranscriptLine) => l.kind));
void api.subagents.list().then((all: TerminalBackgroundAgents[]) => all.length);
void api.subagents.watchTranscript('t1' as TerminalId, 'a1').then((t) => t.omitted);
// N12：框的排版设置，可选字段，老数据没有它
const arrange: FrameArrange = { auto: true, layout: 'tidy' };
void arrange;
// N11：历史会话，只读
void api.history.list().then((all: SessionSummary[]) => all.filter((x) => x.agent === 'claude' && x.source === 'terminal').map((x) => x.title));
// N11：左边栏的开关和宽度随白板保存，可选字段
const left: BoardState['leftPanel'] = { open: true, width: 280 };
void left;
// PL3：Prompt queue。队列随白板保存；额度上限在 TerminalUsage.limit；watch 可以按 owner 分开
const queue: PromptQueueSettings = { on: true, prompts: [{ id: 'p1', text: 'Add tests' }], sent: [], paused: false, keepAwake: true, running: false };
const qdata: TerminalWindowData['queue'] = queue;
void qdata;
const limit: UsageLimit = { kind: 'five_hour', resetsAt: '2026-10-27T07:30:00.000Z', at: null, detail: null };
void limit;
void api.usage.watch('t1' as TerminalId, 'prompt-queue');
void api.app.setKeepAwake(true);
// PL3 / IS-113（0.1.14）：armed 记下碰到上限的时间，limit 被清掉也不忘
const armedQueue: PromptQueueSettings = { ...queue, armed: { resetsAt: Date.parse('2026-10-27T07:30:00.000Z'), at: Date.now() } };
const disarmed: PromptQueueSettings = { ...queue, armed: null };
void armedQueue; void disarmed;
// LA0（0.1.15）：启动预设、Hide from agents、命令里的密码
const presets: LaunchPreset[] = [
  { id: 'p1', name: 'harlequin · shop dev', target: { kind: 'command', command: 'harlequin -P dev' }, hideFromAgents: true },
  { id: 'p2', name: 'Teach me', target: { kind: 'agent', agent: 'claude', prompt: '/teach' }, hideFromAgents: false },
];
const globalPresets: Settings['launchPresets'] = presets;
const projectPresets: ProjectPatch = { launchPresets: presets };
const hidden: TerminalWindowData = { ...termData, hideFromAgents: true };
const blocked: boolean = findInlineSecret('pgcli postgres://a:b@h/db') !== null;
const shown: string = redactCommand('pgcli postgres://a:b@h/db');
void globalPresets; void projectPresets; void hidden; void blocked; void shown;
