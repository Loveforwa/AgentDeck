// CR15：真的 agentdeck 命令（tools/agentdeck-cli，起子进程）连真的 /cli。命令本身的细节在 tools/agentdeck-cli 的测试里。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMINAL_ID_ENV, TERMINAL_KEY_ENV } from '@agentdeck/contracts';
import type { BoardEvent } from '@agentdeck/contracts';
import { createFakeServices, SAMPLE, seedSample } from '@agentdeck/fakes';
import type { FakeServices } from '@agentdeck/fakes';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startMcpServer, terminalKey } from '../src/index.ts';
import type { McpHttpServer } from '../src/index.ts';

const CLI = fileURLToPath(new URL('../../../tools/agentdeck-cli/bin/agentdeck.mjs', import.meta.url));
const TOKEN = 'd'.repeat(64);
const ME = SAMPLE.terminals.loginClaude;

let fakes: FakeServices;
let events: BoardEvent[];
let server: McpHttpServer;
let dir: string;

beforeEach(async () => {
  ({ fakes } = createFakeServices({ silenceMs: 0, recordingFor: () => null }));
  seedSample(fakes);
  events = [];
  dir = mkdtempSync(join(tmpdir(), 'agentdeck-cli-e2e-'));
  server = await startMcpServer({
    token: TOKEN,
    port: 0,
    apiFile: join(dir, 'run', 'api.json'),
    projects: fakes.projects,
    workspaces: fakes.workspaces,
    agents: fakes.agents,
    terminals: fakes.terminals,
    status: fakes.status,
    emit: (e) => events.push(e),
    homeDir: SAMPLE.home,
    crew: () => fakes.crew,
    sessions: () => fakes.sessions,
  });
});

afterEach(async () => {
  await server.close();
  fakes.terminals.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function agentdeck(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        AGENTDECK_API_FILE: join(dir, 'run', 'api.json'),
        [TERMINAL_ID_ENV]: ME,
        [TERMINAL_KEY_ENV]: terminalKey(TOKEN, ME),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

it('agentdeck notify "hi" reaches the board as the calling terminal', async () => {
  const r = await agentdeck(['notify', 'hi']);
  expect(r).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(r.stdout)).toEqual({ ok: true, data: { notified: true } });
  expect(events).toEqual([{ type: 'board.notify', from: ME, message: 'hi' }]);
});

it('agentdeck help lists what this terminal can run', async () => {
  const r = await agentdeck(['help']);
  expect(r.code).toBe(0);
  const usages = JSON.parse(r.stdout).data.commands.map((c: { usage: string }) => c.usage);
  expect(usages).toContain('agentdeck notify <message>');
  expect(usages.some((u: string) => u.startsWith('agentdeck session'))).toBe(false);
});

it('outside a crew: “Not in a crew.”, exit 1; someone else’s id with my key: Unauthorized', async () => {
  const r = await agentdeck(['crew', 'plan']);
  expect(r.code).toBe(1);
  expect(r.stderr.split('\n')[0]).toBe('Not in a crew.');
  const spoof = await agentdeck(['crew', 'status'], { [TERMINAL_ID_ENV]: SAMPLE.terminals.loginCodex });
  expect(spoof.code).toBe(1);
  expect(spoof.stderr.split('\n')[0]).toBe('Unauthorized');
  expect(events).toEqual([]);
});
