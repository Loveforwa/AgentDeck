// CR14：一份工具实现，MCP 和命令行（POST /cli）两个入口；每个终端一把钥匙；按集群角色放行；api.json。
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_PATH, CONTRACTS_VERSION } from '@agentdeck/contracts';
import type { BoardEvent, CliResponse, CrewId, Session, TerminalId } from '@agentdeck/contracts';
import { createFakeServices, SAMPLE, seedSample } from '@agentdeck/fakes';
import type { FakeServices } from '@agentdeck/fakes';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateInjection, LEAD_ONLY_TOOLS, SERVER_INSTRUCTIONS, startMcpServer, terminalKey, TOOLS } from '../src/index.ts';
import type { McpHttpServer, McpHttpServerOptions } from '../src/index.ts';

const TOKEN = 'c'.repeat(64);
const T = SAMPLE.terminals;

let fakes: FakeServices;
let events: BoardEvent[];
let refused: { terminalId: TerminalId; command: string; message: string }[];
let server: McpHttpServer;
let dir: string;
const clients: Client[] = [];

function deps(extra: Partial<McpHttpServerOptions> = {}): McpHttpServerOptions {
  return {
    token: TOKEN,
    port: 0,
    projects: fakes.projects,
    workspaces: fakes.workspaces,
    agents: fakes.agents,
    terminals: fakes.terminals,
    status: fakes.status,
    emit: (e) => events.push(e),
    homeDir: SAMPLE.home,
    submitDelayMs: 0,
    crew: () => fakes.crew,
    sessions: () => fakes.sessions,
    onCliRefused: (r) => refused.push(r),
    ...extra,
  };
}

beforeEach(async () => {
  ({ fakes } = createFakeServices({ silenceMs: 0, recordingFor: () => null }));
  seedSample(fakes);
  events = [];
  refused = [];
  dir = mkdtempSync(join(tmpdir(), 'agentdeck-cli-'));
  server = await startMcpServer(deps());
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await server.close();
  fakes.terminals.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const key = (id: string) => terminalKey(TOKEN, id);

/** 像 agentdeck 命令那样调：POST /cli，带终端 id 和钥匙。 */
async function cli(
  terminal: string,
  command: string,
  args: string[] = [],
  opts: { key?: string; stdin?: string } = {},
): Promise<{ status: number; body: CliResponse }> {
  const r = await fetch(`http://127.0.0.1:${server.port}${CLI_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key ?? key(terminal)}`, 'x-agentdeck-terminal': terminal },
    body: JSON.stringify({ v: 1, command, args, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) }),
  });
  return { status: r.status, body: (await r.json()) as CliResponse };
}

/** 像新开的 claude 那样连 MCP：Bearer 是这个终端的钥匙。 */
async function connect(terminal: string, bearer = key(terminal)): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  const headers = { Authorization: `Bearer ${bearer}`, 'x-agentdeck-terminal': terminal };
  await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url), { requestInit: { headers } }));
  clients.push(client);
  return client;
}

const errorOf = (r: { body: CliResponse }) => (r.body.ok ? null : r.body.error.message);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 命令返回的 JSON，测试里直接按字段断言
const dataOf = (r: { body: CliResponse }): any => (r.body.ok ? r.body.data : undefined);

/** 自由模式的集群：Lead（term-lead-…）开了一个 codex 子 session “race”。 */
async function freeCrew(): Promise<{ crewId: CrewId; lead: TerminalId; worker: TerminalId; workerSession: Session }> {
  const crew = await fakes.crew.create({
    projectId: SAMPLE.projects.agentdeck,
    name: 'login-fix',
    mode: 'free',
    goal: 'Fix the login race',
    baseBranch: 'main',
    roles: [{ role: 'lead', agents: ['claude'], count: 1 }],
    limits: { maxAtOnce: 3, stopAfter: null, waitForLimits: true, keepAwake: false },
    askMe: [],
    free: { allowedAgents: ['claude', 'codex'], maxAtOnce: 3, stopAfter: null, keepAwake: false, autoApprove: false },
  });
  const lead = fakes.crew.leadTerminal(crew.id);
  const spawned = await cli(lead, 'session open', ['--agent', 'codex', '--label', 'race'], { stdin: 'Check the refresh race.' });
  expect(spawned.body.ok).toBe(true);
  const workerSession = (await fakes.sessions.list()).find((s) => s.label === 'race')!;
  return { crewId: crew.id, lead, worker: workerSession.terminalId!, workerSession };
}

describe('CR14 · terminal keys', () => {
  it('the key is HMAC(token, terminal id); the server hands it out per terminal', () => {
    expect(key(T.loginClaude)).toMatch(/^[0-9a-f]{64}$/);
    expect(key(T.loginClaude)).not.toBe(key(T.loginCodex));
    expect(server.keyFor(T.loginClaude)).toBe(key(T.loginClaude));
  });

  it('/cli: a key that doesn’t match the terminal id is 401 Unauthorized', async () => {
    // TC-61 第 5 步：Worker 把 AGENTDECK_TERM 改成 Lead 的 id，带的还是自己的钥匙
    const r = await cli(T.loginClaude, 'help', [], { key: key(T.loginCodex) });
    expect(r.status).toBe(401);
    expect(errorOf(r)).toBe('Unauthorized');
    expect((await cli(T.loginClaude, 'help', [], { key: 'nope' })).status).toBe(401);
    // 共用 token 不收：命令行只认钥匙
    expect((await cli(T.loginClaude, 'help', [], { key: TOKEN })).status).toBe(401);
    expect((await cli(T.loginClaude, 'help')).status).toBe(200);
  });

  it('MCP: the terminal’s key works, someone else’s key is 401, the old shared token still works (one version)', async () => {
    expect((await (await connect(T.loginClaude)).listTools()).tools).toHaveLength(11);
    await expect(connect(T.loginClaude, key(T.loginCodex))).rejects.toThrow();
    expect((await (await connect(T.loginClaude, TOKEN)).listTools()).tools).toHaveLength(11);
  });

  it('browser requests and foreign hosts are refused on /cli too', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}${CLI_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key(T.loginClaude)}`, 'x-agentdeck-terminal': T.loginClaude, Origin: 'https://evil.example' },
      body: JSON.stringify({ v: 1, command: 'help', args: [] }),
    });
    expect(r.status).toBe(403);
  });

  it('a body that isn’t a CliRequest is 400', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}${CLI_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key(T.loginClaude)}`, 'x-agentdeck-terminal': T.loginClaude },
      body: JSON.stringify({ v: 2, command: 'help' }),
    });
    expect(r.status).toBe(400);
  });
});

describe('CR14 · one implementation, two entries', () => {
  it('notify through /cli and through MCP give the same result and the same board event', async () => {
    const viaMcp = (await (await connect(T.loginClaude)).callTool({ name: 'notify', arguments: { message: 'Tests  passed' } })) as {
      content: { text: string }[];
    };
    const viaCli = await cli(T.loginClaude, 'notify', ['Tests', ' passed']);
    expect(viaCli.body).toEqual({ ok: true, data: JSON.parse(viaMcp.content[0]!.text) });
    expect(events.filter((e) => e.type === 'board.notify')).toEqual([
      { type: 'board.notify', from: T.loginClaude, message: 'Tests passed' },
      { type: 'board.notify', from: T.loginClaude, message: 'Tests passed' },
    ]);
  });

  it('open goes to open_browser: same checks, same result', async () => {
    const viaMcp = (await (await connect(T.loginCodex)).callTool({ name: 'open_browser', arguments: { url: 'localhost:5173' } })) as {
      content: { text: string }[];
    };
    const viaCli = await cli(T.loginCodex, 'open', ['localhost:5173']);
    expect(viaCli.body).toEqual({ ok: true, data: JSON.parse(viaMcp.content[0]!.text) });
    expect(errorOf(await cli(T.loginCodex, 'open', ['javascript:alert(1)']))).toBe('Only http(s) URLs and local files can be opened: javascript:alert(1)');
    expect(errorOf(await cli(T.loginCodex, 'open'))).toBe('Usage: agentdeck open <url>');
  });

  it('notify takes long text from stdin', async () => {
    expect((await cli(T.loginClaude, 'notify', [], { stdin: 'Ready\nfor review\n' })).body.ok).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'board.notify', from: T.loginClaude, message: 'Ready for review' });
  });

  it('unknown commands say how to get help', async () => {
    const r = await cli(T.loginClaude, 'deploy', ['now']);
    expect(errorOf(r)).toBe('Unknown command: deploy. Run agentdeck help.');
    expect(refused).toEqual([{ terminalId: T.loginClaude, command: 'deploy', message: 'Unknown command: deploy. Run agentdeck help.' }]);
  });
});

describe('CR14 · crew roles', () => {
  it('outside a crew: tools/list still has the 11 tools; crew commands say “Not in a crew.”', async () => {
    const { tools } = await (await connect(T.loginClaude)).listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools).toHaveLength(11);
    expect(errorOf(await cli(T.loginClaude, 'crew status'))).toBe('Not in a crew.');
    expect(errorOf(await cli(T.loginClaude, 'session open', ['--agent', 'codex'], { stdin: 'x' }))).toBe('Not in a crew.');
    expect(refused.map((r) => r.command)).toEqual(['crew status', 'session open']);
  });

  it('a worker can’t run Lead commands (TC-61 3, 4) and doesn’t see open_terminals, create_workspace, send_to_terminal', async () => {
    const { worker, lead } = await freeCrew();
    expect(errorOf(await cli(worker, 'session open', ['--agent', 'claude'], { stdin: 'x' }))).toBe('Only the Lead can open sessions.');
    expect(errorOf(await cli(worker, 'session list'))).toBe('Only the Lead can manage sessions.');
    expect(errorOf(await cli(worker, 'crew add', ['--title', 'X']))).toBe('Only the Lead can change the plan.');
    expect(errorOf(await cli(worker, 'crew status'))).toBe('Only the Lead can run agentdeck crew status.');
    expect((await fakes.crew.sessions((await fakes.crew.membership(lead))!.crewId)).map((s) => s.label)).toEqual(['race']);

    const workerTools = (await (await connect(worker)).listTools()).tools.map((t) => t.name);
    expect(workerTools).toHaveLength(8);
    for (const name of LEAD_ONLY_TOOLS) expect(workerTools).not.toContain(name);
    // 调了也没有
    const r = (await (await connect(worker)).callTool({ name: 'open_terminals', arguments: { count: 1 } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    // Lead 照旧 11 个
    expect((await (await connect(lead)).listTools()).tools).toHaveLength(11);
  });

  it('the Lead runs crew and session commands (TC-61 6)', async () => {
    const { lead, crewId } = await freeCrew();
    const status = dataOf(await cli(lead, 'crew status'));
    expect(status.crew.name).toBe('login-fix');
    expect(status.sessions.map((s: { label: string }) => s.label)).toEqual(['race']);
    expect(dataOf(await cli(lead, 'session list')).map((s: { label: string; agent: string }) => [s.label, s.agent])).toEqual([['race', 'codex']]);
    // 没给 --label：agent 名，重了加 -2
    await cli(lead, 'session open', ['--agent', 'codex'], { stdin: 'Write the README.' });
    await cli(lead, 'session open', ['--agent', 'codex'], { stdin: 'Write the docs.' });
    expect((await fakes.crew.sessions(crewId)).map((s) => s.label)).toEqual(['race', 'codex', 'codex-2']);
    expect(errorOf(await cli(lead, 'session open', ['--agent', 'codex']))).toMatch(/^Give the prompt on stdin/);

    expect(errorOf(await cli(lead, 'session send', ['race'], { stdin: 'status?' }))).toBe(
      'race is still working. Run agentdeck session wait race, then send again.',
    );
    fakes.crew.setSessionStatus(crewId, 'race', 'idle', 'Found it: refresh races the retry.');
    expect(dataOf(await cli(lead, 'session send', ['race'], { stdin: 'Fix it.' }))).toEqual({ sent: true, label: 'race' });
    expect(fakes.crew.sent.at(-1)?.text).toBe('Fix it.');
    fakes.crew.setSessionStatus(crewId, 'race', 'idle', 'Fixed.');
    expect(dataOf(await cli(lead, 'session result', ['race']))).toEqual({ text: 'Fixed.', source: 'transcript' });
    expect(dataOf(await cli(lead, 'crew note', ['refresh', 'and', 'retry', 'race']))).toEqual({ noted: true });
    expect(dataOf(await cli(lead, 'crew merge', ['race'])).state).toBe('merged');
    expect(dataOf(await cli(lead, 'session close', ['race']))).toEqual({ closed: 'race' });
  });

  it('session read / send go through the AH7 / AH11 guard like the MCP tools', async () => {
    const { lead, worker, crewId } = await freeCrew();
    fakes.crew.setSessionStatus(crewId, 'race', 'idle', 'line 1\nline 2');
    fakes.status.track(worker, { agent: 'codex', workspaceId: null }, 'idle');
    fakes.status.askQuestion(worker, 'Which branch?');
    expect(errorOf(await cli(lead, 'session send', ['race'], { stdin: 'main' }))).toBe('This terminal is waiting for the user. Use the inbox.');
    expect(fakes.crew.sent).toEqual([]);
    // 读不挡在等你的
    expect(dataOf(await cli(lead, 'session read', ['race'])).lines).toBe('line 1\nline 2');

    await server.close();
    server = await startMcpServer(deps({ hiddenFromAgents: async () => new Set([worker]) }));
    expect(errorOf(await cli(lead, 'session read', ['race']))).toBe('The user hid this terminal from agents');
    expect(errorOf(await cli(lead, 'session result', ['race']))).toBe('The user hid this terminal from agents');
    expect(errorOf(await cli(lead, 'session send', ['race'], { stdin: 'x' }))).toBe('The user hid this terminal from agents');
  });

  it('without a CrewService, crew and session say they are not available yet', async () => {
    await server.close();
    server = await startMcpServer(deps({ crew: () => null }));
    expect(errorOf(await cli(T.loginClaude, 'crew status'))).toBe('crew is not available yet');
    expect(errorOf(await cli(T.loginClaude, 'session list'))).toBe('session is not available yet');
    expect((await (await connect(T.loginClaude)).listTools()).tools).toHaveLength(11);
    // help 只列能用的
    const usages = dataOf(await cli(T.loginClaude, 'help')).commands.map((c: { usage: string }) => c.usage);
    expect(usages).toEqual(['agentdeck open <url>', 'agentdeck notify <message>', 'agentdeck help [group]']);
  });

  it('doc, flow, lesson, run, job, out are routed for every terminal but not available yet; forge only for forge terminals', async () => {
    for (const command of ['doc open', 'flow verdicts', 'lesson propose', 'run start', 'job start', 'out add']) {
      expect(errorOf(await cli(T.loginClaude, command, ['x']))).toBe(`${command.split(' ')[0]} is not available yet`);
    }
    expect(errorOf(await cli(T.loginClaude, 'forge draft'))).toBe('Only terminals opened from an issue or pull request can run agentdeck forge.');
    const forge = fakes.sessions.open({
      agent: 'claude',
      cwd: SAMPLE.paths.agentdeckLogin,
      origin: { kind: 'forge', repo: 'owner/name', mode: 'work', number: 12 },
      terminalId: 'term-forge' as TerminalId,
    });
    expect(forge.terminalId).toBe('term-forge');
    expect(errorOf(await cli('term-forge', 'forge draft'))).toBe('forge is not available yet');
  });

  it('help lists what this terminal may run: the Lead sees session commands, a worker doesn’t', async () => {
    const { lead, worker } = await freeCrew();
    const usages = async (t: string) => dataOf(await cli(t, 'help')).commands.map((c: { usage: string }) => c.usage.split(' ').slice(0, 3).join(' '));
    expect(await usages(lead)).toEqual(expect.arrayContaining(['agentdeck session open', 'agentdeck crew status', 'agentdeck notify <message>']));
    const w = await usages(worker);
    expect(w.some((u: string) => u.startsWith('agentdeck session'))).toBe(false);
    expect(w.some((u: string) => u.startsWith('agentdeck crew'))).toBe(false);
    expect(w).toContain('agentdeck notify <message>');
  });
});

describe('CR14 · api.json', () => {
  it('is written on start with the url and the contracts version, and follows the port', async () => {
    const file = join(dir, 'run', 'api.json');
    await server.close();
    server = await startMcpServer(deps({ apiFile: file }));
    const first = JSON.parse(readFileSync(file, 'utf8'));
    expect(first).toEqual({ v: 1, url: `http://127.0.0.1:${server.port}`, version: CONTRACTS_VERSION });
    expect(server.apiUrl).toBe(first.url);

    const old = server;
    server = await startMcpServer(deps({ apiFile: file }));
    expect(server.port).not.toBe(old.port);
    expect(JSON.parse(readFileSync(file, 'utf8')).url).toBe(`http://127.0.0.1:${server.port}`);
    // 旧的关掉时不删新写的
    await old.close();
    expect(existsSync(file)).toBe(true);
    await server.close();
    expect(existsSync(file)).toBe(false);
    server = await startMcpServer(deps());
  });
});

describe('CR14 · IS-100 and the injection estimate', () => {
  it('server instructions are two sentences', () => {
    expect(SERVER_INSTRUCTIONS.split(/(?<=\.) /)).toHaveLength(2);
    expect(SERVER_INSTRUCTIONS.length / 4).toBeLessThan(90);
  });

  it('estimateInjection counts chars / 4 of our own text, per agent', () => {
    const [claude] = estimateInjection('claude');
    const [codex] = estimateInjection('codex');
    expect(claude).toMatchObject({ itemId: 'mcp:built-in:agentdeck', mode: 'deferred' });
    expect(codex).toMatchObject({ itemId: 'mcp:built-in:agentdeck', mode: 'upfront' });
    // C7：完整定义约 1,910，延迟加载时只剩名字和 instructions
    expect(codex!.tokensPerTurn).toBeGreaterThan(1500);
    expect(codex!.tokensPerTurn).toBeLessThan(2600);
    expect(claude!.tokensPerTurn).toBeLessThan(250);
    expect(estimateInjection('codex', { omit: LEAD_ONLY_TOOLS })[0]!.tokensPerTurn).toBeLessThan(codex!.tokensPerTurn!);
    expect(estimateInjection('pi')).toEqual([]);
    expect(estimateInjection('kimi')).toEqual([]);
  });
});
