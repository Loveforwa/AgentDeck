// 用真的 codex 连一次（N1）：照 agent-adapters 的 codexMcpOverrides 用 `-c mcp_servers.agentdeck.*` 挂上（token、终端 id 只给环境变量名），
// 起 `codex app-server`（stdio JSON-RPC），列出 MCP 服务的状态、再让它调一次 list_workspaces，看 token 和调用者对不对。
// 不开会话、不发提示词、不连模型；CODEX_HOME 用临时目录，不碰 ~/.codex。
// 默认跳过。手动跑：AGENTDECK_REAL_CODEX=1 pnpm --filter @agentdeck/mcp-server test real-codex

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeServices, SAMPLE, seedSample } from '@agentdeck/fakes';
import { describe, expect, it } from 'vitest';
import { startMcpServer } from '../src/index.ts';

const REAL = process.env.AGENTDECK_REAL_CODEX === '1';

/** 和 packages/agent-adapters 的 codexMcpOverrides 一样（服务包之间不互相 import，这里抄一份）。 */
function overrides(url: string): string[] {
  return [
    '-c',
    `mcp_servers.agentdeck.url=${JSON.stringify(url)}`,
    '-c',
    'mcp_servers.agentdeck.bearer_token_env_var="AGENTDECK_MCP_TOKEN"',
    '-c',
    'mcp_servers.agentdeck.env_http_headers={"x-agentdeck-terminal"="AGENTDECK_TERM"}',
  ];
}

type Request = (replies: unknown[]) => { method: string; params?: unknown };

/** 起 app-server，按顺序发请求（每个请求可以用前面的回复），收齐每个 id 的回复。 */
function appServer(args: string[], env: NodeJS.ProcessEnv, requests: Request[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = new Map<number, unknown>();
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`codex app-server timed out\n${stderr}`));
    }, 60_000);
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    let next = 0;
    const sendNext = () => {
      const make = requests[next];
      if (!make) return;
      const r = make(requests.slice(0, next).map((_, i) => replies.get(i + 2)));
      send({ id: next + 2, method: r.method, ...(r.params !== undefined ? { params: r.params } : {}) });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg: { id?: number; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ method: 'initialized' });
          sendNext();
        } else if (typeof msg.id === 'number' && msg.id >= 2 && !replies.has(msg.id)) {
          replies.set(msg.id, msg.error ? { error: msg.error } : msg.result);
          next += 1;
          if (next < requests.length) sendNext();
          else {
            clearTimeout(timer);
            child.kill();
            resolve(requests.map((_, i) => replies.get(i + 2)));
          }
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agentdeck-test', version: '0.0.0' } } });
  });
}

describe.skipIf(!REAL)('real codex', () => {
  it('attaches the AgentDeck MCP from -c flags, authenticates from the env and sends the caller terminal', async () => {
    const { fakes } = createFakeServices({ silenceMs: 0, recordingFor: () => null });
    seedSample(fakes);
    const token = 'c'.repeat(64);
    const server = await startMcpServer({
      token,
      port: 0,
      projects: fakes.projects,
      workspaces: fakes.workspaces,
      agents: fakes.agents,
      terminals: fakes.terminals,
      status: fakes.status,
      homeDir: SAMPLE.home,
      emit: () => {},
    });
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    try {
      const env = { ...process.env, CODEX_HOME: home, AGENTDECK_MCP_TOKEN: token, AGENTDECK_TERM: SAMPLE.terminals.loginClaude };
      // thread/start 只建会话（写进临时 CODEX_HOME），不发消息、不连模型；mcpServer/tool/call 要一个 threadId
      const [status, , called] = await appServer(overrides(server.endpoint.url), env, [
        () => ({ method: 'mcpServerStatus/list', params: {} }),
        () => ({ method: 'thread/start', params: { cwd: home } }),
        ([, thread]) => ({
          method: 'mcpServer/tool/call',
          params: { threadId: (thread as { thread: { id: string } }).thread.id, server: 'agentdeck', tool: 'list_workspaces', arguments: {} },
        }),
      ]);
      const text = JSON.stringify(status);
      expect(text).toContain('agentdeck');
      expect(text).toContain('open_terminals');
      const current = JSON.stringify(called);
      expect(current).toContain('feat/login');
      expect(current).toMatch(/\\"current\\": true/);
    } finally {
      await server.close();
      fakes.terminals.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
