import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardEvent, TerminalId, TerminalWindowData } from '@agentdeck/contracts';
import { createFakeServices, SAMPLE, seedSample } from '@agentdeck/fakes';
import type { FakeServices } from '@agentdeck/fakes';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { literalKeys, loadOrCreateToken, startMcpServer } from '../src/index.ts';
import type { McpHttpServer } from '../src/index.ts';

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
      'list_terminals',
      'list_workspaces',
      'open_browser',
      'open_terminal',
      'read_terminal',
      'send_to_terminal',
    ]);
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
