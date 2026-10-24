import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDeckError, type AgentDeckEvent, type Workspace } from '@agentdeck/contracts';
import { MCP_SENDER_ID, startAppMcp, viaRegistry } from '../src/main/mcp.ts';
import { createServiceRegistry } from '../src/main/registry.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('viaRegistry', () => {
  it('calls the registered service outside any window and turns { error } back into AgentDeckError', async () => {
    const registry = createServiceRegistry();
    let sender: number | undefined;
    registry.register('workspaces', {
      list: async () => {
        sender = registry.context()?.senderId;
        return [];
      },
      rename: async () => {
        throw new AgentDeckError({ code: 'invalid-argument', message: 'Name is taken' });
      },
    });
    const ws = viaRegistry(registry, 'workspaces');
    expect(await ws.list()).toEqual([]);
    expect(sender).toBe(MCP_SENDER_ID);
    await expect(ws.rename('w' as never, 'x')).rejects.toMatchObject({ code: 'invalid-argument', message: 'Name is taken' });
    await expect(viaRegistry(registry, 'git').status('/x')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('startAppMcp', () => {
  it('serves the tools over the registry; services that are not registered yet are a tool error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-mcp-'));
    dirs.push(home);
    const registry = createServiceRegistry();
    const workspace = { id: 'ws-1', projectId: 'p-1', name: 'main', path: '/repo', branch: 'main', repos: [], mode: 'main-folder' } as unknown as Workspace;
    registry.register('projects', { list: async () => [] });
    registry.register('workspaces', { list: async () => [workspace] });
    const events: AgentDeckEvent[] = [];
    const server = await startAppMcp({ registry, emit: (e) => events.push(e), homeDir: home, port: 0 });
    try {
      const token = readFileSync(join(home, '.agentdeck/run/mcp-token'), 'utf8').trim();
      expect(server.endpoint.token).toBe(token);
      const call = async (name: string, args: object = {}) => {
        const res = await fetch(server.endpoint.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        });
        return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
      };
      const listed = await call('list_workspaces');
      expect(JSON.parse(listed.content[0]!.text).workspaces[0]).toMatchObject({ id: 'ws-1', current: false });
      const browser = await call('open_browser', { url: 'http://localhost:3000/', workspace_id: 'ws-1' });
      expect(browser.isError).toBeUndefined();
      expect(events).toEqual([expect.objectContaining({ type: 'board.open-window', highlight: true })]);
      const terminals = await call('list_terminals');
      expect(terminals).toMatchObject({ isError: true, content: [{ text: 'Service not available: terminals' }] });
    } finally {
      await server.close();
    }
  });
});
