// ApprovalService（PL1 Auto-approve、X3 Approve all）：decide 的矩阵、按键批准和 couldnt-approve 的时间、
// Approve all 的结果、记录、needs-you、omp 的屏幕规则、破坏性名单、FILE_TOOLS。

import { isAutoApproveOn } from '@agentdeck/contracts';
import type {
  AgentHookEvent,
  AgentKind,
  ApprovalRecord,
  HookEnvelope,
  RequestId,
  StatusEvent,
  TerminalId,
  WorkspaceId,
} from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_AGENTS } from '../src/adapters/known.ts';
import { parsePermissionRequest } from '../src/hook-payload.ts';
import type { ReceivedHook } from '../src/hook-server.ts';
import { ApprovalServiceImpl } from '../src/status/approval.ts';
import type { ApprovalRecordStore } from '../src/status/approval.ts';
import { AutoApproveScopes } from '../src/status/auto-approve.ts';
import { compilePatterns, DEFAULT_DESTRUCTIVE_PATTERNS, isDestructive } from '../src/status/destructive.ts';
import { StatusMachine } from '../src/status/machine.ts';
import { matchOmpApproval } from '../src/status/screens.ts';
import { approvalStrategy, autoApproveSupport } from '../src/status/support.ts';

const W1 = 'ws-1' as WorkspaceId;
const W2 = 'ws-2' as WorkspaceId;
const T1 = 't1' as TerminalId;
const T2 = 't2' as TerminalId;
const T3 = 't3' as TerminalId;

const KEYS: Record<string, string[] | null> = { claude: ['1'], codex: ['y'], omp: ['Up', 'Enter'], pi: null, kimi: null, shell: null };

const OMP_SCREEN = [
  '⏺ Running the tests',
  '',
  '╭──────────────────────────────╮',
  'Allow tool: bash',
  'pnpm test',
  '╰──────────────────────────────╯',
  '│ → Approve                    │',
  '│   Deny                       │',
  '',
  '  up/down navigate  enter select  esc cancel',
];

let events: StatusEvent[];
let sent: [TerminalId, string[]][];
let screens: Map<TerminalId, string[]>;
let onKeys: ((id: TerminalId, keys: string[]) => void) | null;
let status: StatusMachine;
let svc: ApprovalServiceImpl;
let store: ApprovalRecord[] | null;

function setup(opts: { records?: boolean } = {}) {
  events = [];
  sent = [];
  screens = new Map();
  onKeys = null;
  store = opts.records ? [] : null;
  let approvals: ApprovalServiceImpl | null = null;
  status = new StatusMachine({
    emit: (e) => {
      events.push(e);
      approvals?.onStatusEvent(e);
    },
    destructivePatterns: () => DEFAULT_DESTRUCTIVE_PATTERNS,
  });
  const records: ApprovalRecordStore | undefined = store
    ? {
        add: (r) => store!.push(r),
        history: (ws, limit) => store!.filter((r) => r.request.workspaceId === ws).reverse().slice(0, limit),
      }
    : undefined;
  svc = new ApprovalServiceImpl({
    status,
    terminals: {
      sendKeys: async (id, keys) => {
        sent.push([id, keys]);
        onKeys?.(id, keys);
      },
      lastLines: async (id, n) => (screens.get(id) ?? []).slice(-n),
    },
    approveKeys: (agent) => KEYS[agent] ?? null,
    destructivePatterns: () => DEFAULT_DESTRUCTIVE_PATTERNS,
    emit: (e) => events.push(e),
    ...(records ? { records } : {}),
  });
  approvals = svc;
}

function track(id: TerminalId, agent: AgentKind, ws: WorkspaceId | null) {
  status.track(id, { agent, workspaceId: ws, hooks: agent !== 'shell', status: 'running' });
}

function ask(id: TerminalId, command: string) {
  status.onHook(id, { type: 'permission-request', tool: 'Bash', summary: command, command });
  return status.get(id)!.pending!;
}

/** agent 收到按键后继续干活（PostToolUse）。 */
function proceedOnKeys() {
  onKeys = (id) => status.onHook(id, { type: 'prompt-submitted' });
}

function hook(id: TerminalId, agent: AgentKind, event: AgentHookEvent | null): ReceivedHook {
  const envelope: HookEnvelope = { v: 1, terminalId: id, agent, hookName: 'PermissionRequest', payload: {}, at: '', expectsReply: true };
  return { terminalId: id, agent, hookName: 'PermissionRequest', event, envelope };
}

const bash = (command: string): AgentHookEvent => ({ type: 'permission-request', tool: 'Bash', summary: command, command });
const ofType = <T extends StatusEvent['type']>(t: T) => events.filter((e): e is Extract<StatusEvent, { type: T }> => e.type === t);

beforeEach(() => {
  vi.useFakeTimers();
  setup();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('decide (hook answer for claude / codex)', () => {
  beforeEach(() => {
    track(T1, 'claude', W1);
    track(T2, 'codex', W1);
    track(T3, 'claude', W2);
  });

  it('is none while Auto-approve is off', () => {
    expect(svc.decide(hook(T1, 'claude', bash('pnpm test')))).toBe('none');
  });

  it('allows permission requests in a frame that has it on, for claude and codex, not other frames', async () => {
    await svc.setAutoApprove(W1, true);
    expect(svc.decide(hook(T1, 'claude', bash('pnpm test')))).toBe('allow');
    expect(svc.decide(hook(T2, 'codex', bash('pnpm test')))).toBe('allow');
    expect(svc.decide(hook(T3, 'claude', bash('pnpm test')))).toBe('none');
  });

  it('a terminal can be on alone, or off inside a frame that is on', async () => {
    await svc.setTerminalAutoApprove(T3, true);
    expect(svc.decide(hook(T3, 'claude', bash('ls')))).toBe('allow');
    await svc.setAutoApprove(W1, true);
    await svc.setTerminalAutoApprove(T1, false);
    expect(svc.decide(hook(T1, 'claude', bash('ls')))).toBe('none');
    expect(svc.decide(hook(T2, 'codex', bash('ls')))).toBe('allow');
  });

  it('turning the frame off turns all of its terminals off, including ones turned on alone', async () => {
    await svc.setTerminalAutoApprove(T1, true);
    await svc.setAutoApprove(W1, true);
    await svc.setAutoApprove(W1, false);
    expect(svc.decide(hook(T1, 'claude', bash('ls')))).toBe('none');
    expect(await svc.autoApproveState()).toEqual({ workspaces: [], terminals: [] });
  });

  it('terminals opened later in a frame that is on get it too', async () => {
    await svc.setAutoApprove(W1, true);
    const late = 'late' as TerminalId;
    track(late, 'claude', W1);
    expect(svc.decide(hook(late, 'claude', bash('ls')))).toBe('allow');
  });

  it('never answers questions, destructive commands, unknown terminals or agents without a hook', async () => {
    await svc.setAutoApprove(W1, true);
    expect(svc.decide(hook(T1, 'claude', { type: 'question', summary: 'Tea or coffee?' }))).toBe('none');
    expect(svc.decide(hook(T1, 'claude', null))).toBe('none');
    expect(svc.decide(hook(T1, 'claude', bash('rm -rf dist')))).toBe('none');
    expect(svc.decide(hook(T1, 'claude', { type: 'permission-request', tool: 'Edit', summary: 'Edit /repo/.env', command: null }))).toBe('none');
    expect(svc.decide(hook('nobody' as TerminalId, 'claude', bash('ls')))).toBe('none');
    track('omp-1' as TerminalId, 'omp', W1);
    expect(svc.decide(hook('omp-1' as TerminalId, 'omp', bash('ls')))).toBe('none');
  });

  it('records each hook approval and says so', async () => {
    await svc.setAutoApprove(W1, true);
    svc.noteAutoAllowed(hook(T1, 'claude', bash('pnpm test')));
    const [rec] = await svc.history(W1, 10);
    expect(rec).toMatchObject({ by: 'auto-approve', request: { terminalId: T1, summary: 'pnpm test', kind: 'approval', workspaceId: W1 } });
    expect(ofType('approval.auto-approved')).toHaveLength(1);
  });

  it('reports state changes with since times', async () => {
    await svc.setAutoApprove(W1, true);
    await svc.setTerminalAutoApprove(T1, false);
    const changes = ofType('approval.auto-approve-changed');
    expect(changes).toHaveLength(2);
    const state = changes[1]!.state;
    expect(state.workspaces.map((w) => w.workspaceId)).toEqual([W1]);
    expect(state.terminals).toEqual([{ terminalId: T1, on: false, since: expect.any(String) }]);
    expect(isAutoApproveOn(state, T1, W1)).toBe(false);
    expect(isAutoApproveOn(state, T2, W1)).toBe(true);
  });

  it('refuses to turn it on for an agent that is not supported', async () => {
    track('k' as TerminalId, 'kimi', W1);
    await expect(svc.setTerminalAutoApprove('k' as TerminalId, true)).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('key fallback and couldnt-approve', () => {
  it('a request already waiting when Auto-approve is turned on gets the approve-once key', async () => {
    track(T1, 'claude', W1);
    proceedOnKeys();
    ask(T1, 'pnpm test');
    await svc.setAutoApprove(W1, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toEqual([[T1, ['1']]]);
    expect(status.get(T1)!.status).toBe('running');
    expect((await svc.history(W1, 10)).map((r) => r.by)).toEqual(['auto-approve']);
    expect(ofType('approval.auto-approved')).toHaveLength(1);
  });

  it('codex gets y, never p or a', async () => {
    track(T2, 'codex', W1);
    proceedOnKeys();
    await svc.setTerminalAutoApprove(T2, true);
    ask(T2, 'cargo build');
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toEqual([[T2, ['y']]]);
  });

  it('records couldnt-approve when the terminal is still waiting 2 s after the key, and does not retry', async () => {
    track(T1, 'claude', W1);
    const req = ask(T1, 'pnpm test');
    await svc.setAutoApprove(W1, true);
    await vi.advanceTimersByTimeAsync(400 + 1999);
    expect(sent).toHaveLength(1);
    expect(ofType('approval.needs-you')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ofType('approval.needs-you')).toEqual([
      { type: 'approval.needs-you', terminalId: T1, reason: 'couldnt-approve', request: expect.objectContaining({ id: req.id }) },
    ]);
    expect(await svc.autoApproveNeedsYou()).toMatchObject([{ terminalId: T1, reason: 'couldnt-approve' }]);
    expect(await svc.history(W1, 10)).toEqual([]);
    // 状态机再发一次同一个请求的变化也不重按
    status.onTerminalEvent({ type: 'terminal.activity', id: T1, at: '' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(1);
    // 你处理了（agent 继续干活）：needs-you 清掉
    status.onHook(T1, { type: 'prompt-submitted' });
    expect(ofType('approval.needs-you').at(-1)).toEqual({ type: 'approval.needs-you', terminalId: T1, reason: null, request: null });
  });

  it('turning it on again retries a request that could not be approved', async () => {
    track(T1, 'claude', W1);
    ask(T1, 'pnpm test');
    await svc.setAutoApprove(W1, true);
    await vi.advanceTimersByTimeAsync(3000);
    proceedOnKeys();
    await svc.setAutoApprove(W1, false);
    await svc.setAutoApprove(W1, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(2);
    expect(status.get(T1)!.status).toBe('running');
  });

  it('does not press keys for destructive requests or questions; says why in needs-you', async () => {
    track(T1, 'claude', W1);
    track(T2, 'claude', W1);
    await svc.setAutoApprove(W1, true);
    ask(T1, 'git push --force origin main');
    status.onHook(T2, { type: 'question', summary: 'Which approach?' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
    expect((await svc.autoApproveNeedsYou()).map((n) => [n.terminalId, n.reason])).toEqual([
      [T1, 'destructive'],
      [T2, 'question'],
    ]);
  });

  it('needs-you is only for terminals with Auto-approve on, and clears when it is turned off', async () => {
    track(T1, 'claude', W1);
    ask(T1, 'rm -rf dist');
    expect(await svc.autoApproveNeedsYou()).toEqual([]);
    await svc.setTerminalAutoApprove(T1, true);
    expect(await svc.autoApproveNeedsYou()).toMatchObject([{ reason: 'destructive' }]);
    await svc.setTerminalAutoApprove(T1, null);
    expect(await svc.autoApproveNeedsYou()).toEqual([]);
    expect(ofType('approval.needs-you').map((e) => e.reason)).toEqual(['destructive', null]);
  });

  it('turning it off before the key goes out cancels it', async () => {
    track(T1, 'claude', W1);
    ask(T1, 'pnpm test');
    await svc.setAutoApprove(W1, true);
    await svc.setAutoApprove(W1, false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toEqual([]);
  });
});

describe('omp (screen check, then Up Enter)', () => {
  const O = 'omp-1' as TerminalId;

  it('sends Up Enter once the Approve / Deny list is on screen', async () => {
    track(O, 'omp', W1);
    proceedOnKeys();
    await svc.setAutoApprove(W1, true);
    ask(O, 'pnpm test');
    await vi.advanceTimersByTimeAsync(400);
    expect(sent).toEqual([]); // 确认框还没画出来
    screens.set(O, OMP_SCREEN);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toEqual([[O, ['Up', 'Enter']]]);
    expect((await svc.history(W1, 10)).map((r) => r.by)).toEqual(['auto-approve']);
  });

  it('gives up without pressing anything when the list never shows up', async () => {
    track(O, 'omp', W1);
    await svc.setAutoApprove(W1, true);
    ask(O, 'pnpm test');
    await vi.advanceTimersByTimeAsync(400 + 2500);
    expect(sent).toEqual([]);
    expect(await svc.autoApproveNeedsYou()).toMatchObject([{ terminalId: O, reason: 'couldnt-approve' }]);
  });

  it('screen matcher: positive, and the ask tool / scrolled-away negatives', () => {
    expect(matchOmpApproval(OMP_SCREEN)).toMatchObject({ tool: 'bash', command: 'pnpm test', summary: 'pnpm test' });
    expect(matchOmpApproval(['Allow tool: edit', 'path: src/a.ts', '› Approve', '  Deny'])).toMatchObject({ tool: 'edit', command: null, summary: 'edit path: src/a.ts' });
    // ask 工具的选项不是 Approve / Deny
    expect(matchOmpApproval(['Which one?', '→ Option A', '  Option B'])).toBeNull();
    // 只有 Approve / Deny 没有 Allow tool: 标题
    expect(matchOmpApproval(['Ready?', '→ Approve', '  Deny'])).toBeNull();
    // 确认框已经被新输出顶上去了
    expect(matchOmpApproval([...OMP_SCREEN, ...Array.from({ length: 12 }, (_, i) => `output ${i}`)])).toBeNull();
    expect(matchOmpApproval([])).toBeNull();
  });
});

describe('approve (Approve all, X3)', () => {
  it('approves the selected waiting terminals and reports each one', async () => {
    track(T1, 'claude', W1);
    track(T2, 'codex', W1);
    track(T3, 'claude', W1);
    const a = ask(T1, 'pnpm test');
    const b = ask(T2, 'cargo test');
    const c = ask(T3, 'make');
    onKeys = (id) => {
      if (id !== T3) status.onHook(id, { type: 'prompt-submitted' }); // T3 卡住
    };
    const p = svc.approve([a.id, b.id, c.id, 'gone' as RequestId]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual([
      { id: a.id, ok: true },
      { id: b.id, ok: true },
      { id: c.id, ok: false, reason: 'couldnt-approve' },
      { id: 'gone', ok: false, reason: 'gone' },
    ]);
    expect(sent.map(([id, k]) => [id, k.join(' ')])).toEqual([
      [T1, '1'],
      [T2, 'y'],
      [T3, '1'],
    ]);
    expect((await svc.history(W1, 10)).map((r) => [r.request.terminalId, r.by])).toEqual([
      [T2, 'approve-all'],
      [T1, 'approve-all'],
    ]);
  });

  it('leaves destructive requests out unless they are explicitly included', async () => {
    track(T1, 'claude', W1);
    track(T2, 'claude', W1);
    proceedOnKeys();
    const safe = ask(T1, 'pnpm test');
    const bad = ask(T2, 'git reset --hard HEAD~3');
    expect(await svc.approve([safe.id, bad.id])).toEqual([
      { id: safe.id, ok: true },
      { id: bad.id, ok: false, reason: 'destructive' },
    ]);
    expect(await svc.approve([bad.id], { by: 'approve-all', includeDestructive: true })).toEqual([{ id: bad.id, ok: true }]);
  });

  it('one request from the user is approved even if destructive, and recorded as user', async () => {
    track(T1, 'claude', W1);
    proceedOnKeys();
    const r = ask(T1, 'rm -rf dist');
    expect(await svc.approve([r.id])).toEqual([{ id: r.id, ok: true }]);
    expect((await svc.history(W1, 10)).map((x) => x.by)).toEqual(['user']);
  });

  it('questions are gone, agents without keys are unsupported', async () => {
    track(T1, 'claude', W1);
    track(T2, 'pi', W1);
    status.onHook(T1, { type: 'question', summary: 'Tea?' });
    const q = status.get(T1)!.pending!;
    const p = ask(T2, 'ls');
    expect(await svc.approve([q.id, p.id])).toEqual([
      { id: q.id, ok: false, reason: 'gone' },
      { id: p.id, ok: false, reason: 'unsupported' },
    ]);
    expect(sent).toEqual([]);
  });

  it('Approve all and Auto-approve on the same request press the key once', async () => {
    track(T1, 'claude', W1);
    proceedOnKeys();
    const r = ask(T1, 'pnpm test');
    await svc.setAutoApprove(W1, true);
    await vi.advanceTimersByTimeAsync(400);
    expect(await svc.approve([r.id])).toEqual([{ id: r.id, ok: false, reason: 'gone' }]);
    expect(sent).toHaveLength(1);
  });
});

describe('history', () => {
  it('newest first, per workspace, limited; written to the record store when given', async () => {
    setup({ records: true });
    track(T1, 'claude', W1);
    track(T2, 'claude', W2);
    proceedOnKeys();
    for (const cmd of ['a', 'b', 'c']) await svc.approve([ask(T1, cmd).id]);
    await svc.approve([ask(T2, 'other').id]);
    expect((await svc.history(W1, 2)).map((r) => r.request.summary)).toEqual(['c', 'b']);
    expect((await svc.history(W2, 10)).map((r) => r.request.summary)).toEqual(['other']);
    expect(store).toHaveLength(4);
  });

  it('keeps records in memory without a store', async () => {
    track(T1, 'claude', W1);
    proceedOnKeys();
    await svc.approve([ask(T1, 'x').id]);
    expect(await svc.history(W1, 10)).toHaveLength(1);
    expect(await svc.history(W2, 10)).toEqual([]);
  });
});

describe('support table', () => {
  it('claude, codex use the hook; omp keys (untested); pi never asks; kimi, shell, custom are unsupported', () => {
    const s = Object.fromEntries(autoApproveSupport().map((x) => [x.agent, [x.method, x.verified, x.note]]));
    expect(s).toEqual({
      claude: ['hook', true, null],
      codex: ['hook', true, null],
      omp: ['keys', false, 'Untested for Oh My Pi'],
      pi: ['never-asks', true, 'pi never asks for approval'],
      kimi: ['unsupported', false, 'Not supported for kimi yet'],
      shell: ['unsupported', false, 'Not supported for shell'],
      custom: ['unsupported', false, 'Not supported for custom'],
    });
  });

  it('every known agent has a row, and keys only where the table presses keys', () => {
    for (const a of KNOWN_AGENTS) {
      const m = approvalStrategy(a.id).method;
      expect(m === 'keys' ? a.approveOnceKeys : null).toEqual(m === 'keys' ? ['Up', 'Enter'] : null);
      if (m !== 'keys') expect(a.approveOnceKeys).toBeNull();
    }
  });

  it('AutoApproveScopes agrees with contracts isAutoApproveOn', () => {
    const s = new AutoApproveScopes();
    s.setWorkspace(W1, true, [], 'now');
    s.setTerminal(T1, false, W1, 'now');
    s.setTerminal(T3, true, W2, 'now');
    s.setTerminal(T2, true, W1, 'now'); // 和框一样：不留单独设置
    expect(s.state().terminals.map((t) => t.terminalId)).toEqual([T1, T3]);
    for (const [id, ws] of [[T1, W1], [T2, W1], [T3, W2], [T2, W2], [T2, null]] as const) {
      expect(s.isOn(id, ws)).toBe(isAutoApproveOn(s.state(), id, ws));
    }
  });
});

describe('destructive defaults', () => {
  const patterns = compilePatterns(DEFAULT_DESTRUCTIVE_PATTERNS);
  const d = (cmd: string) => isDestructive(patterns, cmd, cmd);

  it.each([
    'rm -rf dist',
    'rm -r build',
    'rm -fr node_modules',
    'rm dist -rf',
    'rm --recursive out',
    'cd app && rm -rf .next',
    'sudo rm /etc/hosts',
    'find . -name "*.log" -delete',
    'git push --force',
    'git push -f origin main',
    'git push --force-with-lease',
    'git push origin +main',
    'bash -c "git push -f"',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git clean -xdf',
    'git checkout -- src/',
    'git checkout .',
    'git restore src/a.ts src/b.ts',
    'git restore .',
    'git stash drop',
    'psql -c "DROP TABLE users"',
    'drop database prod;',
    'TRUNCATE orders',
    'psql -c "DELETE FROM users"',
    'redis-cli FLUSHALL',
    'mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/disk2',
    'echo x > /dev/sda',
    'chmod -R 777 /var/www',
    'kubectl delete pod web',
    'terraform destroy',
    'cat .env',
  ])('waits for %s', (cmd) => {
    expect(d(cmd)).toBe(true);
  });

  it.each([
    'pnpm test',
    'rm file.txt',
    'npm rm lodash',
    'git push origin main',
    'git push; ls -f',
    'git reset --soft HEAD~1',
    'git clean -n',
    'git checkout main',
    'git checkout -b feat/x',
    'git restore --staged src/a.ts',
    'git stash',
    'echo truncated output',
    'DELETE FROM users WHERE id = 1',
    'chmod 644 a.txt',
    'cat .envrc',
    'ls -rf',
  ])('does not wait for %s', (cmd) => {
    expect(d(cmd)).toBe(false);
  });
});

describe('hook payloads', () => {
  it('omp lowercase edit / write carry the path, so .env rules match', () => {
    const e = parsePermissionRequest({ tool_name: 'edit', tool_input: { path: '/repo/.env', edits: [] } });
    expect(e).toEqual({ type: 'permission-request', tool: 'edit', summary: 'edit /repo/.env', command: null });
    const w = parsePermissionRequest({ tool_name: 'write', tool_input: { path: 'src/a.ts', content: 'x' } });
    expect(w).toMatchObject({ summary: 'write src/a.ts' });
    expect(isDestructive(compilePatterns(DEFAULT_DESTRUCTIVE_PATTERNS), null, 'edit /repo/.env')).toBe(true);
  });

  it('codex request_user_input is a question, never an approval', () => {
    expect(parsePermissionRequest({ tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Pick one' }] } })).toEqual({
      type: 'question',
      summary: 'Pick one',
    });
  });
});
