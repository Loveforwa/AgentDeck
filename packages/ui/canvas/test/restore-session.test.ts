// X6：恢复上次会话。白板只认 WindowTypeDefinition.restore，这里注册一个用 agents.start 的假终端类型。

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionId, TerminalWindowData, WindowComponentProps, WindowId, WindowRestoreSupport } from '@agentdeck/contracts';
import { AgentDeckError } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { createWindowRegistry } from '../src/registry.ts';
import { restoreHeadline, restoreLines, restoreResultMessage, RESTORE_LIST_MAX, type RestoreSessionItem } from '../src/model/restore.ts';

const Nothing = (_p: WindowComponentProps<any>) => null; // eslint-disable-line @typescript-eslint/no-explicit-any
const wid = (s: string) => s as WindowId;
const flush = () => new Promise((r) => setTimeout(r, 0));

let api: FakeApi;
let c: BoardController;

function setup(opts: { restoreFails?: string } = {}) {
  api = createFakeApi();
  const restore: WindowRestoreSupport<TerminalWindowData> & { calls: TerminalWindowData[] } = {
    calls: [],
    describe: (d, live) => {
      if (d.terminalId && live.has(d.terminalId)) return null;
      const shell = d.agent === 'shell';
      return { kind: shell ? 'shell' : 'agent', label: shell ? 'zsh' : d.agent, detail: d.sessionId ? 'Resumes the conversation' : 'Starts fresh', fresh: !shell && !d.sessionId };
    },
    restore: async (d, ctx) => {
      restore.calls.push(d);
      if (opts.restoreFails && d.agent === opts.restoreFails) throw new AgentDeckError({ code: 'invalid-argument', message: `Folder not found: ${d.cwd}` });
      const res = await api.agents.start({
        agent: d.agent,
        cwd: d.cwd,
        workspaceId: ctx.workspaceId,
        mode: d.sessionId ? { kind: 'resume', sessionId: d.sessionId } : { kind: 'new' },
      });
      return { patch: { terminalId: res.terminalId, cmd: res.cmd, args: res.args, sessionId: res.sessionId }, fresh: !d.sessionId && d.agent !== 'shell' };
    },
  };
  const registry = createWindowRegistry();
  registry.register<TerminalWindowData>({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    summaryBelow: { w: 320, h: 200 },
    component: Nothing,
    create: (init) => ({ terminalId: null, agent: 'shell', cmd: 'zsh', args: [], cwd: '~', sessionId: null, startCommand: null, ...init }),
    restore,
  });
  registry.register({ type: 'browser', label: 'Browser', defaultSize: { w: 520, h: 360 }, minSize: { w: 110, h: 60 }, component: Nothing, create: () => ({}) });
  const notify = vi.fn();
  c = new BoardController({ api, registry, homeDir: SAMPLE.home, notify });
  c.setPane({ w: 1200, h: 800 });
  return { restore, notify };
}

afterEach(() => {
  c?.dispose();
  api?.dispose();
});

const term = (id: string) => c.windowById(wid(id))!.data as TerminalWindowData;

describe('Restore your last session? (X6)', () => {
  it('does not ask when the tmux sessions are still there (normal reopen reattaches)', async () => {
    setup();
    await c.start();
    await flush();
    expect(c.state.dialog).toBeNull();
  });

  it('after Stop all and quit / a restart: asks once, listing what comes back', async () => {
    setup();
    api.fakes.terminals.hostLost(); // tmux 服务没了，白板还是上次存的
    await c.start();
    await flush();
    const d = c.state.dialog;
    expect(d?.kind).toBe('restore-session');
    if (d?.kind !== 'restore-session') return;
    // 示例白板有 5 个终端：claude ×2、codex、两个 Shell；网页窗口不算
    expect(d.items.map((i) => [i.windowId, i.kind])).toEqual([
      ['win-dev-server', 'shell'],
      ['win-login-claude', 'agent'],
      ['win-login-codex', 'agent'],
      ['win-shop-claude', 'agent'],
      ['win-shop-shell', 'shell'],
    ]);
    expect(restoreHeadline(d.items)).toBe('5 terminals in 3 workspaces: 3 agents and 2 shells.');
  });

  it('Restore all restarts each window in place with a new terminal id, resuming recorded sessions', async () => {
    const { restore, notify } = setup();
    api.fakes.terminals.hostLost();
    await c.start();
    await flush();
    const before = c.state.windows.map((w) => [w.id, w.rect]);
    expect(before).toHaveLength(6);
    const oldClaude = term('win-login-claude').terminalId;
    const outcomes = await c.restoreAll();
    expect(c.state.dialog).toBeNull();
    expect(outcomes).toHaveLength(5);
    expect(restore.calls).toHaveLength(5);
    // 位置、窗口 id 不变；终端换了新 id，而且都在 tmux 里
    expect(c.state.windows.map((w) => [w.id, w.rect])).toEqual(before);
    expect(term('win-login-claude').terminalId).not.toBe(oldClaude);
    for (const id of ['win-dev-server', 'win-login-claude', 'win-login-codex', 'win-shop-claude', 'win-shop-shell']) {
      expect(api.fakes.terminals.has(term(id).terminalId!)).toBe(true);
    }
    const modes = api.fakes.agents.started.map((s) => [s.request.agent, s.request.mode]);
    expect(modes).toContainEqual(['claude', { kind: 'resume', sessionId: 'session-login' as AgentSessionId }]);
    expect(modes).toContainEqual(['claude', { kind: 'resume', sessionId: 'session-cart' as AgentSessionId }]);
    expect(modes).toContainEqual(['codex', { kind: 'new' }]);
    expect(term('win-login-claude').sessionId).toBe('session-login');
    expect(notify).toHaveBeenLastCalledWith('Restored 5 terminals. codex had no saved conversation and started a new one.');
    // 存进白板
    await c.flush();
    const saved = await api.board.load();
    expect((saved.windows.find((w) => w.id === 'win-login-claude')!.data as TerminalWindowData).terminalId).toBe(term('win-login-claude').terminalId);
  });

  it('a window that fails to restore keeps its place and the toast says why', async () => {
    const { notify } = setup({ restoreFails: 'codex' });
    api.fakes.terminals.hostLost();
    await c.start();
    await flush();
    const outcomes = await c.restoreAll();
    expect(outcomes.filter((o) => o.error).map((o) => o.item.windowId)).toEqual(['win-login-codex']);
    expect(term('win-login-codex').terminalId).toBe(SAMPLE.terminals.loginCodex);
    expect(notify.mock.calls.at(-1)![0]).toMatch(/^Restored 4 terminals\. Couldn’t restore codex: Folder not found: /);
  });

  it('Not now just closes it; each window keeps its own Restore', async () => {
    const { restore } = setup();
    api.fakes.terminals.hostLost();
    await c.start();
    await flush();
    c.closeDialog();
    expect(c.state.dialog).toBeNull();
    expect(restore.calls).toHaveLength(0);
  });

  it('only the windows whose sessions are gone are listed', async () => {
    setup();
    await c.start();
    await api.terminals.kill(SAMPLE.terminals.shopShell);
    await c.checkRestore();
    const d = c.state.dialog;
    expect(d?.kind === 'restore-session' && d.items.map((i) => i.windowId)).toEqual(['win-shop-shell']);
  });

  it('asks again when the tmux server goes away while the app is open', async () => {
    setup();
    await c.start();
    await flush();
    expect(c.state.dialog).toBeNull();
    api.fakes.terminals.hostLost();
    await flush();
    await flush();
    expect(c.state.dialog?.kind).toBe('restore-session');
  });

  it('does not interrupt another dialog', async () => {
    setup();
    await c.start();
    c.openDialog({ kind: 'rename-window', windowId: wid('win-login-claude') });
    api.fakes.terminals.hostLost();
    await c.checkRestore();
    expect(c.state.dialog?.kind).toBe('rename-window');
  });

  it('a window restored meanwhile drops out of the prompt', async () => {
    setup();
    api.fakes.terminals.hostLost();
    await c.start();
    await flush();
    // 都恢复了之后再查一次：没有要恢复的，提示关掉
    await c.restoreAll();
    c.openDialog({ kind: 'restore-session', items: [] });
    await c.checkRestore();
    expect(c.state.dialog).toBeNull();
  });
});

describe('restore prompt text', () => {
  const item = (over: Partial<RestoreSessionItem>): RestoreSessionItem => ({
    windowId: wid('w'),
    workspaceId: null,
    kind: 'agent',
    label: 'claude',
    detail: 'Resumes the conversation',
    fresh: false,
    ...over,
  });

  it('headline counts terminals, workspaces, agents and shells', () => {
    expect(restoreHeadline([item({})])).toBe('1 terminal: 1 agent.');
    expect(restoreHeadline([item({ kind: 'shell', workspaceId: 'a' as never }), item({ kind: 'shell', workspaceId: 'a' as never })])).toBe(
      '2 terminals in 1 workspace: 2 shells.',
    );
  });

  it('lists at most RESTORE_LIST_MAX windows', () => {
    const many = Array.from({ length: RESTORE_LIST_MAX + 3 }, (_, i) => item({ windowId: wid(`w${i}`) }));
    const { lines, more } = restoreLines(many);
    expect(lines).toHaveLength(RESTORE_LIST_MAX);
    expect(more).toBe(3);
  });

  it('result message', () => {
    expect(restoreResultMessage([{ item: item({}), fresh: false, error: null }])).toBe('Restored 1 terminal.');
    expect(
      restoreResultMessage([
        { item: item({ label: 'codex' }), fresh: true, error: null },
        { item: item({ label: 'pi' }), fresh: true, error: null },
        { item: item({ kind: 'shell', label: 'zsh' }), fresh: true, error: null },
      ]),
    ).toBe('Restored 3 terminals. codex and pi had no saved conversation and started a new one.');
    expect(
      restoreResultMessage([
        { item: item({}), fresh: false, error: 'Command not found: claude' },
        { item: item({ label: 'zsh' }), fresh: false, error: 'x' },
      ]),
    ).toBe('Couldn’t restore claude: Command not found: claude (and 1 more)');
  });
});

