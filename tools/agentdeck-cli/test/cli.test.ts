// agentdeck 命令（CR15）：起真的子进程，对着一个只回 JSON 的小服务（HTTP 和 unix socket 各一个）。
// 真服务端（packages/mcp-server 的 /cli）那一段在 mcp-server 的 test/agentdeck-cli.test.ts。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_ENDPOINT_FILE,
  CLI_COMMAND_ACCESS,
  CLI_PATH,
  MCP_TERMINAL_HEADER,
  parseCliCommand,
  TERMINAL_ID_ENV,
  TERMINAL_KEY_ENV,
} from '@agentdeck/contracts';
import type { CliRequest, CliResponse } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as cli from '../bin/agentdeck.mjs';

const SCRIPT = fileURLToPath(new URL('../bin/agentdeck.mjs', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

let dir: string;
let servers: Server[];
let received: { headers: IncomingMessage['headers']; body: CliRequest; path: string }[];
let answer: (req: CliRequest) => { status: number; body: CliResponse };

function run(args: string[], opts: { env?: Record<string, string>; stdin?: string | null } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, [TERMINAL_ID_ENV]: 't-abc', [TERMINAL_KEY_ENV]: 'k'.repeat(64), ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (opts.stdin === null) return; // 管道开着不关
    child.stdin.end(opts.stdin ?? '');
  });
}

function stub(): Server {
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c: Buffer) => (text += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(text) as CliRequest;
      received.push({ headers: req.headers, body, path: req.url ?? '' });
      const a = answer(body);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
  });
  servers.push(server);
  return server;
}

async function listenHttp(): Promise<string> {
  const server = stub();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function writeApi(content: object, path = join(dir, API_ENDPOINT_FILE)): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(content));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentdeck-cli-'));
  servers = [];
  received = [];
  answer = () => ({ status: 200, body: { ok: true, data: { notified: true } } });
});

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(dir, { recursive: true, force: true });
});

describe('agentdeck', () => {
  it('constants match contracts', () => {
    expect(cli.TERMINAL_ID_ENV).toBe(TERMINAL_ID_ENV);
    expect(cli.TERMINAL_KEY_ENV).toBe(TERMINAL_KEY_ENV);
    expect(cli.API_ENDPOINT_FILE).toBe(API_ENDPOINT_FILE);
    expect(cli.CLI_PATH).toBe(CLI_PATH);
    expect(cli.TERMINAL_HEADER).toBe(MCP_TERMINAL_HEADER);
    // 带子命令的组 = contracts 里除了 open、notify 的所有组（help 的第二个词是组名）
    expect([...cli.GROUPS_WITH_VERBS].sort()).toEqual(Object.keys(CLI_COMMAND_ACCESS).filter((g) => g !== 'open' && g !== 'notify').sort());
  });

  it('splits the command the way the server parses it', () => {
    expect(cli.toRequest([])).toEqual({ command: 'help', args: [] });
    expect(cli.toRequest(['--help'])).toEqual({ command: 'help', args: [] });
    expect(cli.toRequest(['help', 'crew'])).toEqual({ command: 'help crew', args: [] });
    expect(cli.toRequest(['notify', 'Tests', 'passed'])).toEqual({ command: 'notify', args: ['Tests', 'passed'] });
    expect(cli.toRequest(['open', 'http://localhost:3000'])).toEqual({ command: 'open', args: ['http://localhost:3000'] });
    expect(cli.toRequest(['crew', 'status', '--since', '23:40'])).toEqual({ command: 'crew status', args: ['--since', '23:40'] });
    expect(cli.toRequest(['session', 'open', '--agent', 'codex'])).toEqual({ command: 'session open', args: ['--agent', 'codex'] });
    expect(cli.toRequest(['crew'])).toEqual({ command: 'crew', args: [] });
    expect(cli.toRequest(['crew', '-h'])).toEqual({ command: 'crew help', args: [] });
    for (const argv of [['crew', 'status'], ['lesson', 'propose', 'x'], ['help']]) {
      expect(parseCliCommand(cli.toRequest(argv).command)).not.toBeNull();
    }
  });

  it('posts a CliRequest with the terminal id and key, prints the JSON and exits 0', async () => {
    writeApi({ v: 1, url: await listenHttp(), version: '0.1.21' });
    const r = await run(['notify', 'hi']);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, data: { notified: true } });
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/cli');
    expect(received[0]!.body).toEqual({ v: 1, command: 'notify', args: ['hi'] });
    expect(received[0]!.headers.authorization).toBe(`Bearer ${'k'.repeat(64)}`);
    expect(received[0]!.headers[MCP_TERMINAL_HEADER]).toBe('t-abc');
  });

  it('long content comes from stdin', async () => {
    writeApi({ v: 1, url: await listenHttp(), version: '0.1.21' });
    await run(['session', 'open', '--agent', 'codex'], { stdin: 'Goal: fix the race.\nFiles: src/auth/**\n' });
    expect(received[0]!.body).toEqual({ v: 1, command: 'session open', args: ['--agent', 'codex'], stdin: 'Goal: fix the race.\nFiles: src/auth/**\n' });
  });

  it('a pipe nobody writes to doesn’t hang it', async () => {
    writeApi({ v: 1, url: await listenHttp(), version: '0.1.21' });
    const r = await run(['help'], { stdin: null });
    expect(r.code).toBe(0);
    expect(received[0]!.body).toEqual({ v: 1, command: 'help', args: [] });
  });

  it('errors: first line is the English reason, then the JSON, exit code 1', async () => {
    answer = () => ({ status: 200, body: { ok: false, error: { code: 'invalid-argument', message: 'Not in a crew.' } } });
    writeApi({ v: 1, url: await listenHttp(), version: '0.1.21' });
    const r = await run(['crew', 'plan']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    const [first, json] = r.stderr.split('\n');
    expect(first).toBe('Not in a crew.');
    expect(JSON.parse(json!)).toEqual({ ok: false, error: { code: 'invalid-argument', message: 'Not in a crew.' } });
  });

  it('401 prints Unauthorized', async () => {
    answer = () => ({ status: 401, body: { ok: false, error: { code: 'invalid-argument', message: 'Unauthorized' } } });
    writeApi({ v: 1, url: await listenHttp(), version: '0.1.21' });
    const r = await run(['crew', 'plan']);
    expect(r.code).toBe(1);
    expect(r.stderr.split('\n')[0]).toBe('Unauthorized');
  });

  it('reads api.json on every call: a new port is picked up', async () => {
    writeApi({ v: 1, url: await listenHttp(), version: '0.1.21' });
    expect((await run(['help'])).code).toBe(0);
    writeApi({ v: 1, url: await listenHttp(), version: '0.1.21' });
    expect((await run(['help'])).code).toBe(0);
    expect(new Set(received.map((r) => r.headers.host)).size).toBe(2);
  });

  it('AGENTDECK_API_FILE points at another AgentDeck’s api.json (the wrapper script sets it)', async () => {
    const file = writeApi({ v: 1, url: await listenHttp(), version: '0.1.21' }, join(dir, 'data', 'run', 'api.json'));
    expect((await run(['help'], { env: { AGENTDECK_API_FILE: file } })).code).toBe(0);
  });

  it('talks HTTP over a unix socket when api.json has socket', async () => {
    const socket = join(dir, 'cli.sock');
    const server = stub();
    await new Promise<void>((r) => server.listen(socket, () => r()));
    writeApi({ v: 1, socket, version: '0.1.21' });
    expect((await run(['notify', 'hi'])).code).toBe(0);
    expect(received[0]!.body.command).toBe('notify');
  });

  it('outside an AgentDeck terminal, without AgentDeck, or when it is gone: exit 2 with a reason', async () => {
    const outside = await run(['help'], { env: { [TERMINAL_ID_ENV]: '', [TERMINAL_KEY_ENV]: '' } });
    expect(outside.code).toBe(2);
    expect(outside.stderr.split('\n')[0]).toBe('Not in an AgentDeck terminal: agentdeck only works in terminals AgentDeck opened.');

    const noFile = await run(['help']);
    expect(noFile.code).toBe(2);
    expect(noFile.stderr.split('\n')[0]).toBe(`AgentDeck isn’t running (no ${join(dir, API_ENDPOINT_FILE)})`);

    writeApi({ v: 1, url: 'http://127.0.0.1:1', version: '0.1.21' });
    const gone = await run(['help']);
    expect(gone.code).toBe(2);
    expect(gone.stderr.split('\n')[0]).toBe('Can’t reach AgentDeck at http://127.0.0.1:1. Is it running?');
  });
});
