// 用真的 claude 连一次：配置照 agent-adapters 的 claudeMcpConfig 写（token、终端 id 走环境变量），
// 让它调 list_workspaces 和 open_browser，看服务收到的调用者和白板事件对不对。服务后面是假服务和示例数据。
// 默认跳过。手动跑：AGENTDECK_REAL_CLAUDE=1 pnpm --filter @agentdeck/mcp-server test real-claude
// 需要本机装了 claude 并且已登录；用 -p 跑一轮，只放行这两个工具，不改任何文件。

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BoardEvent } from '@agentdeck/contracts';
import { createFakeServices, SAMPLE, seedSample } from '@agentdeck/fakes';
import { describe, expect, it } from 'vitest';
import { startMcpServer } from '../src/index.ts';

const REAL = process.env.AGENTDECK_REAL_CLAUDE === '1';
const CWD = fileURLToPath(new URL('..', import.meta.url));

describe.skipIf(!REAL)('real claude', () => {
  it('connects with the env-expanded headers, knows its workspace and opens a browser window', async () => {
    const { fakes } = createFakeServices({ silenceMs: 0, recordingFor: () => null });
    seedSample(fakes);
    const events: BoardEvent[] = [];
    const token = 'f'.repeat(64);
    const server = await startMcpServer({
      token,
      port: 0,
      projects: fakes.projects,
      workspaces: fakes.workspaces,
      agents: fakes.agents,
      terminals: fakes.terminals,
      status: fakes.status,
      homeDir: SAMPLE.home,
      emit: (e) => events.push(e),
    });
    try {
      const config = {
        mcpServers: {
          agentdeck: {
            type: 'http',
            url: server.endpoint.url,
            headers: { Authorization: 'Bearer ${AGENTDECK_MCP_TOKEN}', 'x-agentdeck-terminal': '${AGENTDECK_TERM}' },
          },
        },
      };
      const prompt =
        'Call the agentdeck list_workspaces tool, then call open_browser with url http://localhost:5173/ . ' +
        'Finally reply with only the name of the workspace marked current.';
      const out = await new Promise<string>((resolve, reject) => {
        execFile(
          'claude',
          [
            '-p',
            '--strict-mcp-config',
            '--mcp-config',
            JSON.stringify(config),
            '--allowedTools',
            'mcp__agentdeck__list_workspaces',
            'mcp__agentdeck__open_browser',
            '--',
            prompt,
          ],
          { cwd: CWD, timeout: 180_000, env: { ...process.env, AGENTDECK_TERM: SAMPLE.terminals.loginClaude, AGENTDECK_MCP_TOKEN: token } },
          (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)),
        );
      });
      expect(out).toContain('feat/login');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'board.open-window',
          request: expect.objectContaining({ type: 'browser', workspaceId: SAMPLE.workspaces.agentdeckLogin }),
        }),
      );
    } finally {
      await server.close();
      fakes.terminals.dispose();
    }
  }, 200_000);
});
