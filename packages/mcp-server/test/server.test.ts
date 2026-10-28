import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardEvent, TerminalId, TerminalStatus, TerminalWindowData } from '@agentdeck/contracts';
import { createFakeServices, SAMPLE, seedSample } from '@agentdeck/fakes';
import type { FakeServices } from '@agentdeck/fakes';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentTerminalRefusal, browserTarget, literalKeys, WAITING_FOR_USER_MESSAGE,loadOrCreateToken, SERVER_INSTRUCTIONS, startMcpServer } from '../src/index.ts';
import type { McpHttpServer, McpHttpServerOptions } from '../src/index.ts';

const TOKEN = 'a'.repeat(64);
const T = SAMPLE.terminals;
const W = SAMPLE.workspaces;

let fakes: FakeServices;
let events: BoardEvent[];
let inputs: TerminalId[];
let server: McpHttpServer;
const clients: Client[] = [];

beforeEach(async () => {
  ({ fakes } = createFakeServices({ silenceMs: 0, recordingFor: () => null }));
  seedSample(fakes);
  events = [];
  inputs = [];
  server = await startMcpServer({
    token: TOKEN,
    port: 0,
    projects: fakes.projects,
    workspaces: fakes.workspaces,
    agents: fakes.agents,
    terminals: fakes.terminals,
    status: fakes.status,
    emit: (e) => events.push(e),
    homeDir: SAMPLE.home,
    onInput: (id) => inputs.push(id),
    submitDelayMs: 0,
  });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await server.close();
  fakes.terminals.dispose();
});

/** 像 claude 那样连：Authorization + 终端 id 请求头。 */
async function connect(terminal: string | null = T.loginClaude, token = TOKEN): Promise<Client> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (terminal !== null) headers['x-agentdeck-terminal'] = terminal;
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url), { requestInit: { headers } }));
  clients.push(client);
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具返回的 JSON，测试里直接按字段断言
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ error: boolean; value: any }> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]!.text;
  return r.isError ? { error: true, value: text } : { error: false, value: JSON.parse(text) };
}

describe('HTTP', () => {
  it('listens on 127.0.0.1 and gives the endpoint with the token', () => {
    expect(server.endpoint).toEqual({ url: `http://127.0.0.1:${server.port}/mcp`, token: TOKEN });
  });

  it('rejects a wrong token, browser requests, foreign Host headers and other paths', async () => {
    const post = (headers: Record<string, string>, path = '/mcp') =>
      fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }).then((r) => r.status);
    expect(await post({ Authorization: 'Bearer wrong' })).toBe(401);
    expect(await post({})).toBe(401);
    expect(await post({ Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' })).toBe(403);
    expect(await post({ Authorization: `Bearer ${TOKEN}` }, '/other')).toBe(404);
    await expect(connect(T.loginClaude, 'b'.repeat(64))).rejects.toThrow();
  });

  it('falls back to a random port when the preferred one is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const taken = (blocker.address() as { port: number }).port;
    const other = await startMcpServer({ ...deps(), token: TOKEN, port: taken });
    expect(other.port).not.toBe(taken);
    await other.close();
    blocker.close();
  });

  it('is stateless: a client keeps working after the server restarts on the same port', async () => {
    const client = await connect();
    const port = server.port;
    await server.close();
    server = await startMcpServer({ ...deps(), token: TOKEN, port });
    expect((await call(client, 'list_workspaces')).error).toBe(false);
  });
});

describe('tools', () => {
  it('lists the tools', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_workspace',
      'focus_window',
      'list_terminals',
      'list_windows',
      'list_workspaces',
      'notify',
      'open_browser',
      'open_terminal',
      'open_terminals',
      'read_terminal',
      'send_to_terminal',
    ]);
  });

  it('tells the agent when to use the tools (server instructions)', async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).toMatch(/open_terminals/);
  });

  it('list_workspaces marks the caller’s workspace', async () => {
    const { value } = await call(await connect(), 'list_workspaces');
    expect(value.projects.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([SAMPLE.projects.agentdeck, SAMPLE.projects.shop]));
    const current = value.workspaces.filter((w: { current: boolean }) => w.current);
    expect(current.map((w: { id: string }) => w.id)).toEqual([W.agentdeckLogin]);
  });

  it('list_terminals joins status, filters by workspace and marks the caller', async () => {
    const { value } = await call(await connect(), 'list_terminals', { workspace_id: W.agentdeckLogin });
    expect(value.terminals.map((t: { id: string }) => t.id).sort()).toEqual([T.loginClaude, T.loginCodex].sort());
    const codex = value.terminals.find((t: { id: string }) => t.id === T.loginCodex);
    expect(codex).toMatchObject({ status: 'needs-approval', waitingFor: { kind: 'approval', summary: 'pnpm test' }, self: false });
    expect(value.terminals.find((t: { id: string }) => t.id === T.loginClaude).self).toBe(true);
  });

  it('open_terminal starts the agent in the caller’s workspace with the prompt and asks the board to show it', async () => {
    const { value } = await call(await connect(), 'open_terminal', { agent: 'codex', prompt: 'review the login form' });
    expect(value.workspaceId).toBe(W.agentdeckLogin);
    const started = fakes.agents.started.at(-1)!;
    expect(started.request).toMatchObject({
      agent: 'codex',
      cwd: SAMPLE.paths.agentdeckLogin,
      workspaceId: W.agentdeckLogin,
      prompt: 'review the login form',
      mode: { kind: 'new' },
    });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe('board.open-window');
    if (e.type !== 'board.open-window') return;
    expect(e.request.workspaceId).toBe(W.agentdeckLogin);
    expect(e.request.type).toBe('terminal');
    expect(e.request.data as TerminalWindowData).toMatchObject({ terminalId: value.terminalId, agent: 'codex', cwd: SAMPLE.paths.agentdeckLogin });
  });

  it('open_terminal: workspace_id null is loose in the home folder; unknown workspaces are an error', async () => {
    const client = await connect();
    await call(client, 'open_terminal', { agent: 'shell', workspace_id: null, command: 'pnpm dev' });
    expect(fakes.agents.started.at(-1)!.request).toMatchObject({ cwd: SAMPLE.home, workspaceId: null, command: 'pnpm dev' });
    expect(await call(client, 'open_terminal', { workspace_id: 'nope' })).toEqual({ error: true, value: 'Workspace not found: nope' });
  });

  it('create_workspace: new worktree in the caller’s project, frame first, setup shell, then the agent with its prompt', async () => {
    const { value, error } = await call(await connect(), 'create_workspace', { branch: 'feat/signup', prompt: 'build the signup page' });
    expect(error).toBe(false);
    expect(value).toMatchObject({ branch: 'feat/signup', setupCommand: 'pnpm install' });
    expect(events.map((e) => e.type)).toEqual(['board.add-frame', 'board.open-window', 'board.open-window']);
    const frame = events[0]!;
    if (frame.type === 'board.add-frame') expect(frame.workspace.id).toBe(value.workspaceId);
    const [setup, agent] = fakes.agents.started.slice(-2).map((s) => s.request);
    expect(setup).toMatchObject({ agent: 'shell', command: 'pnpm install', workspaceId: value.workspaceId });
    expect(agent).toMatchObject({ agent: 'claude', prompt: 'build the signup page', workspaceId: value.workspaceId, cwd: value.path });
    const setupWindow = events[1]!;
    if (setupWindow.type === 'board.open-window') expect(setupWindow.highlight).toBe(false);
  });

  it('create_workspace: agent "none" only adds the frame; outside a workspace project_id is needed', async () => {
    const { value } = await call(await connect(), 'create_workspace', { branch: 'feat/x', agent: 'none' });
    expect(value.terminalId).toBeNull();
    const outside = await call(await connect(null), 'create_workspace', { branch: 'feat/y' });
    expect(outside).toEqual({ error: true, value: 'Pass project_id: you are not in a workspace (see list_workspaces)' });
  });

  it('create_workspace reports service errors as tool errors', async () => {
    const r = await call(await connect(), 'create_workspace', { branch: 'feat/login', agent: 'none' });
    expect(r.error).toBe(true);
    expect(events).toEqual([]);
  });

  it('open_browser opens in the caller’s frame and reuses by origin', async () => {
    await call(await connect(), 'open_browser', { url: 'http://localhost:5173/login' });
    const e = events[0]!;
    if (e.type !== 'board.open-window') throw new Error('expected open-window');
    expect(e.request).toMatchObject({
      type: 'browser',
      workspaceId: W.agentdeckLogin,
      reuseKey: 'http://localhost:5173',
      data: { url: 'http://localhost:5173/login', mode: 'frame', openedBy: { terminalId: T.loginClaude } },
    });
    // N1：放在调用者终端旁边
    if (e.type === 'board.open-window') expect(e.nearTerminal).toBe(T.loginClaude);
  });

  it('open_browser only takes http(s) URLs and local files', async () => {
    const client = await connect();
    const opened = async (url: string) => {
      const r = await call(client, 'open_browser', { url });
      return r.error ? { error: r.value as string } : r.value.opened;
    };
    expect(await opened('localhost:3000')).toBe('http://localhost:3000/');
    expect(await opened('127.0.0.1:8080/app')).toBe('http://127.0.0.1:8080/app');
    expect(await opened('https://example.com/docs')).toBe('https://example.com/docs');
    expect(await opened('/Users/me/site/index.html')).toBe('/Users/me/site/index.html');
    expect(await opened('file:///Users/me/report%20v2.html')).toBe('/Users/me/report v2.html');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.com/a', 'index.html', '~/site/index.html', '//evil.example/x', 'file://server/share/a.html', 'chrome://settings']) {
      expect(await opened(bad)).toEqual({ error: `Only http(s) URLs and local files can be opened: ${bad}` });
    }
    // 拒绝的不发事件
    expect(events).toHaveLength(5);
  });

  it('browserTarget keeps the reuse key per origin', () => {
    expect(browserTarget('http://localhost:5173')).toBe('http://localhost:5173/');
    expect(browserTarget('  http://localhost:5173/a?b=1#c ')).toBe('http://localhost:5173/a?b=1#c');
    expect(() => browserTarget('')).toThrow();
  });

  it('read_terminal returns the last lines and the status', async () => {
    const { value } = await call(await connect(), 'read_terminal', { terminal_id: T.shopClaude, lines: 3 });
    expect(value.status).toBe('idle');
    expect(value.lines.split('\n').length).toBeLessThanOrEqual(3);
    expect(value.lines).toBe((await fakes.terminals.lastLines(T.shopClaude, 3)).join('\n'));
  });

  it('send_to_terminal types the text, then Enter, and notes the input; never into itself', async () => {
    const client = await connect();
    await call(client, 'send_to_terminal', { terminal_id: T.shopClaude, text: 'run the tests\nthen commit' });
    expect(fakes.terminals.get(T.shopClaude).keys).toEqual([['run the tests then commit'], ['Enter']]);
    expect(inputs).toEqual([T.shopClaude]);
    await call(client, 'send_to_terminal', { terminal_id: T.shopClaude, text: 'draft', submit: false });
    expect(fakes.terminals.get(T.shopClaude).keys.at(-1)).toEqual(['d', 'r', 'a', 'f', 't']);
    expect(await call(client, 'send_to_terminal', { terminal_id: T.loginClaude, text: 'hi' })).toEqual({
      error: true,
      value: 'Can’t send to your own terminal',
    });
  });

  it('workspaceOf from the status machine wins over the terminal folder, including null for loose terminals', async () => {
    await server.close();
    server = await startMcpServer({ ...deps(), token: TOKEN, port: 0, workspaceOf: (id) => (id === T.loginClaude ? null : undefined) });
    const { value } = await call(await connect(), 'list_terminals');
    expect(value.terminals.find((t: { id: string }) => t.id === T.loginClaude).workspaceId).toBeNull();
    expect(value.terminals.find((t: { id: string }) => t.id === T.loginCodex).workspaceId).toBe(W.agentdeckLogin);
  });

  it('a caller whose env had no AGENTDECK_TERM sends the literal placeholder and counts as outside', async () => {
    const { value } = await call(await connect('${AGENTDECK_TERM}'), 'list_workspaces');
    expect(value.workspaces.some((w: { current: boolean }) => w.current)).toBe(false);
  });
});

/** 换一组注入的依赖重开服务（N1 的 board、confirm、onNotify）。 */
async function restart(extra: Partial<McpHttpServerOptions>): Promise<void> {
  await server.close();
  server = await startMcpServer({ ...deps(), token: TOKEN, port: 0, submitDelayMs: 0, ...extra });
}

function groupEvent(): Extract<BoardEvent, { type: 'board.open-group' }> {
  const e = events.find((x) => x.type === 'board.open-group');
  if (!e || e.type !== 'board.open-group') throw new Error('expected board.open-group');
  return e;
}

describe('N1 · open_terminals', () => {
  it('opens n agents in the caller’s workspace with their prompts and asks the board for one group next to the caller', async () => {
    const before = fakes.agents.started.length;
    const { value, error } = await call(await connect(), 'open_terminals', {
      count: 3,
      prompts: ['build the api', 'build the ui', 'write the tests'],
      labels: ['api', 'ui', 'tests'],
    });
    expect(error).toBe(false);
    const started = fakes.agents.started.slice(before).map((s) => s.request);
    expect(started).toHaveLength(3);
    expect(started.map((r) => r.prompt)).toEqual(['build the api', 'build the ui', 'write the tests']);
    for (const r of started) expect(r).toMatchObject({ agent: 'claude', cwd: SAMPLE.paths.agentdeckLogin, workspaceId: W.agentdeckLogin, mode: { kind: 'new' } });
    expect(value.lead).toBe(T.loginClaude);
    expect(value.terminals.map((t: { label: string }) => t.label)).toEqual(['api', 'ui', 'tests']);
    // 一个事件，白板一起放
    expect(events.map((e) => e.type)).toEqual(['board.open-group']);
    const g = groupEvent();
    expect(g.lead).toBe(T.loginClaude);
    expect(g.highlight).toBe(true);
    expect(g.members.map((m) => m.label)).toEqual(['api', 'ui', 'tests']);
    expect(g.members.map((m) => (m.request.data as TerminalWindowData).terminalId)).toEqual(value.terminals.map((t: { terminalId: string }) => t.terminalId));
    for (const m of g.members) expect(m.request).toMatchObject({ type: 'terminal', workspaceId: W.agentdeckLogin });
  });

  it('fewer prompts and labels than terminals is fine; more is an error', async () => {
    const client = await connect();
    const ok = await call(client, 'open_terminals', { count: 2, agent: 'codex', prompts: ['only the first'] });
    expect(ok.error).toBe(false);
    const [a, b] = fakes.agents.started.slice(-2).map((s) => s.request);
    expect(a).toMatchObject({ agent: 'codex', prompt: 'only the first' });
    expect(b!.prompt).toBeUndefined();
    expect(groupEvent().members.map((m) => m.label)).toEqual([null, null]);
    expect(await call(client, 'open_terminals', { count: 1, prompts: ['a', 'b'] })).toEqual({ error: true, value: 'Got 2 prompts for 1 terminals' });
    expect(await call(client, 'open_terminals', { count: 1, labels: ['a', 'b'] })).toEqual({ error: true, value: 'Got 2 labels for 1 terminals' });
  });

  it('up to 6 without asking; more needs the user’s yes', async () => {
    const asked: { title: string; body: string; confirm: string }[] = [];
    let answer = false;
    await restart({
      confirm: async (q) => {
        asked.push(q);
        return answer;
      },
    });
    const client = await connect();
    expect((await call(client, 'open_terminals', { count: 6 })).error).toBe(false);
    expect(asked).toHaveLength(0);

    const before = fakes.agents.started.length;
    expect(await call(client, 'open_terminals', { count: 7 })).toEqual({ error: true, value: 'The user declined opening 7 terminals' });
    expect(asked.at(-1)).toEqual({ title: 'Open 7 terminals?', body: 'An agent wants to open 7 claude terminals in feat/login at once.', confirm: 'Open 7' });
    expect(fakes.agents.started.length).toBe(before);

    answer = true;
    const { value } = await call(client, 'open_terminals', { count: 7 });
    expect(value.terminals).toHaveLength(7);
    expect(await call(client, 'open_terminals', { count: 17 })).toMatchObject({ error: true });
  });

  it('without a way to ask, more than 6 is refused and nothing starts', async () => {
    const before = fakes.agents.started.length;
    const r = await call(await connect(), 'open_terminals', { count: 8 });
    expect(r.error).toBe(true);
    expect(r.value).toMatch(/needs the user’s confirmation/);
    expect(fakes.agents.started.length).toBe(before);
    expect(events).toEqual([]);
  });

  it('a failure part-way still puts the started ones on the board and says where it stopped', async () => {
    let n = 0;
    await restart({
      agents: {
        list: () => fakes.agents.list(),
        start: (req) => (++n === 3 ? Promise.reject(new Error('Command not found: claude')) : fakes.agents.start(req)),
      },
    });
    const { value, error } = await call(await connect(), 'open_terminals', { count: 4 });
    expect(error).toBe(false);
    expect(value.terminals).toHaveLength(2);
    expect(value.error).toBe('Stopped after 2 of 4: Command not found: claude');
    expect(groupEvent().members).toHaveLength(2);
  });

  it('a caller outside AgentDeck gets loose terminals and no lead', async () => {
    const { value } = await call(await connect(null), 'open_terminals', { count: 1, agent: 'shell' });
    expect(value).toMatchObject({ workspaceId: null, lead: null });
    expect(groupEvent().lead).toBeNull();
  });
});

describe('AH7 · send_to_terminal never types into a terminal that waits for the user', () => {
  const WAITING = { error: true, value: 'This terminal is waiting for the user. Use the inbox.' };

  it('needs-approval: refused, no keys sent, no input noted', async () => {
    // 样例里 login 的 codex 停在 “pnpm test” 的批准上
    expect(await call(await connect(T.shopClaude), 'send_to_terminal', { terminal_id: T.loginCodex, text: '1' })).toEqual(WAITING);
    expect(fakes.terminals.get(T.loginCodex).keys).toEqual([]);
    expect(inputs).toEqual([]);
  });

  it('needs-reply: refused too', async () => {
    fakes.status.askQuestion(T.shopClaude, 'Same frame or new terminal?');
    expect(await call(await connect(), 'send_to_terminal', { terminal_id: T.shopClaude, text: 'same frame', submit: false })).toEqual(WAITING);
    expect(fakes.terminals.get(T.shopClaude).keys).toEqual([]);
  });

  it('running and idle: sent as before', async () => {
    const client = await connect();
    // 样例里 dev server 是 running，shop 的 claude 是 idle
    for (const id of [T.devServer, T.shopClaude]) {
      expect(await call(client, 'send_to_terminal', { terminal_id: id, text: 'go on' })).toEqual({ error: false, value: { sent: true, terminalId: id } });
      expect(fakes.terminals.get(id).keys).toEqual([['go on'], ['Enter']]);
    }
    expect(inputs).toEqual([T.devServer, T.shopClaude]);
  });

  it('the target starts waiting between the text and Enter: Enter is not pressed', async () => {
    let calls = 0;
    await restart({
      status: {
        snapshot: async () => {
          if (++calls === 2) fakes.status.requestApproval(T.shopClaude, { summary: 'rm -rf dist', command: 'rm -rf dist' });
          return fakes.status.snapshot();
        },
      },
    });
    expect(await call(await connect(), 'send_to_terminal', { terminal_id: T.shopClaude, text: 'go on' })).toEqual(WAITING);
    expect(fakes.terminals.get(T.shopClaude).keys).toEqual([['go on']]);
  });

  it('the tool description says so; open_terminals prompts are not affected', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'send_to_terminal')!.description).toMatch(/waiting for the user \(status needs-approval or needs-reply\)/);
    // 给新开的终端的第一条消息走 agents.start，不经过 send_to_terminal 的检查
    expect((await call(client, 'open_terminals', { count: 1, prompts: ['review'] })).error).toBe(false);
    expect(fakes.agents.started.at(-1)!.request.prompt).toBe('review');
  });

  it('agentTerminalRefusal: one rule for every entry point (MCP now, /cli and Flow later)', () => {
    const refused = (status: TerminalStatus) => agentTerminalRefusal('send', { status: { status } })?.message ?? null;
    expect(refused('needs-approval')).toBe(WAITING_FOR_USER_MESSAGE);
    expect(refused('needs-reply')).toBe(WAITING_FOR_USER_MESSAGE);
    for (const s of ['starting', 'running', 'idle', 'exited', 'error'] as const) expect(refused(s)).toBeNull();
    expect(agentTerminalRefusal('send', { status: { status: 'needs-approval' } })?.code).toBe('invalid-argument');
    expect(agentTerminalRefusal('send', { status: undefined })).toBeNull();
    // 读不挡
    expect(agentTerminalRefusal('read', { status: { status: 'needs-approval' } })).toBeNull();
  });
});

describe('N1 · list_windows, focus_window, notify', () => {
  it('list_windows: type, title, status, topic, group and self from the saved board', async () => {
    const board = (await fakes.board.load())!;
    // 一组：login 的 claude 是主 agent，codex 是它开的子终端
    const groupId = 'grp-1' as never;
    board.windows = board.windows.map((w) =>
      w.id === 'win-login-claude' ? { ...w, group: { id: groupId, role: 'lead' as const, label: null } } : w.id === 'win-login-codex' ? { ...w, group: { id: groupId, role: 'member' as const, label: 'review' } } : w,
    );
    await fakes.board.save(board);
    fakes.terminals.setTitle(T.loginClaude, 'Fix the login bug');
    await restart({ board: fakes.board });
    const { value } = await call(await connect(), 'list_windows');
    const byId = Object.fromEntries(value.windows.map((w: { id: string }) => [w.id, w]));
    expect(byId['win-login-claude']).toMatchObject({
      type: 'terminal',
      title: 'claude',
      workspaceId: W.agentdeckLogin,
      terminalId: T.loginClaude,
      agent: 'claude',
      topic: 'Fix the login bug',
      group: { id: 'grp-1', role: 'lead', label: null },
      self: true,
    });
    expect(byId['win-login-codex']).toMatchObject({
      status: 'needs-approval',
      waitingFor: { kind: 'approval', summary: 'pnpm test' },
      group: { id: 'grp-1', role: 'member', label: 'review' },
      self: false,
    });
    expect(byId['win-browser']).toMatchObject({ type: 'browser', group: null, self: false });
    expect(byId['win-browser'].url).toBeTruthy();
    expect(byId['win-browser'].terminalId).toBeUndefined();

    const only = await call(await connect(), 'list_windows', { workspace_id: W.shopCart });
    expect(only.value.windows.map((w: { id: string }) => w.id).sort()).toEqual(['win-shop-claude', 'win-shop-shell']);
  });

  it('list_windows without a board is an error', async () => {
    expect(await call(await connect(), 'list_windows')).toEqual({ error: true, value: 'The board isn’t available' });
  });

  it('focus_window asks the board by window or terminal id, checking that it exists', async () => {
    await restart({ board: fakes.board });
    const client = await connect();
    expect((await call(client, 'focus_window', { terminal_id: T.shopClaude })).value).toEqual({ requested: true, terminalId: T.shopClaude });
    expect((await call(client, 'focus_window', { window_id: 'win-browser' })).value).toEqual({ requested: true, windowId: 'win-browser' });
    expect(events).toEqual([
      { type: 'board.focus-window', target: { terminalId: T.shopClaude } },
      { type: 'board.focus-window', target: { windowId: 'win-browser' } },
    ]);
    expect(await call(client, 'focus_window', { terminal_id: 'nope' })).toEqual({ error: true, value: 'Terminal not found: nope' });
    expect(await call(client, 'focus_window', { window_id: 'nope' })).toEqual({ error: true, value: 'Window not found: nope' });
    expect(await call(client, 'focus_window', {})).toEqual({ error: true, value: 'Pass either window_id or terminal_id' });
    expect(events).toHaveLength(2);
  });

  it('notify flashes the caller on the board and hands the message to the app (system notification in the background)', async () => {
    const notes: { terminalId: TerminalId | null; message: string }[] = [];
    await restart({ onNotify: (n) => notes.push(n) });
    expect((await call(await connect(), 'notify', { message: '  Tests\npassed  ' })).value).toEqual({ notified: true });
    expect(events).toEqual([{ type: 'board.notify', from: T.loginClaude, message: 'Tests passed' }]);
    expect(notes).toEqual([{ terminalId: T.loginClaude, message: 'Tests passed' }]);
  });
});

describe('literalKeys', () => {
  it('keeps text literal for tmux send-keys', () => {
    expect(literalKeys('fix the bug')).toEqual(['fix the bug']);
    expect(literalKeys('Enter')).toEqual(['E', 'n', 't', 'e', 'r']);
    expect(literalKeys('a;b;')).toEqual(['a', '\\;', 'b', '\\;']);
    expect(literalKeys('find . -exec rm {} \\;')).toEqual(['find . -exec rm {} \\', '\\;']);
    expect(literalKeys('echo a;;')).toEqual(['echo a', '\\;', '\\;']);
    expect(literalKeys('one\r\ntwo\nthree')).toEqual(['one two three']);
  });
});

describe('loadOrCreateToken', () => {
  it('creates a private token once and reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-token-'));
    try {
      const path = join(dir, 'run', 'mcp-token');
      const a = await loadOrCreateToken(path);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(await loadOrCreateToken(path)).toBe(a);
      writeFileSync(path, 'garbage');
      const b = await loadOrCreateToken(path);
      expect(b).not.toBe(a);
      expect(readFileSync(path, 'utf8').trim()).toBe(b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function deps() {
  return {
    projects: fakes.projects,
    workspaces: fakes.workspaces,
    agents: fakes.agents,
    terminals: fakes.terminals,
    status: fakes.status,
    emit: (e: BoardEvent) => events.push(e),
    homeDir: SAMPLE.home,
  };
}
