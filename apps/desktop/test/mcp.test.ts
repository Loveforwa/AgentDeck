import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDeckError, type AgentDeckEvent, type BoardState, type TerminalInfo, type Workspace } from '@agentdeck/contracts';
import { MCP_SENDER_ID, startAppMcp, viaRegistry, writeMcpPluginDir } from '../src/main/mcp.ts';
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

  it('N1: list_windows reads the board through the registry; notify and the >6 confirmation go to the app', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-mcp-'));
    dirs.push(home);
    const registry = createServiceRegistry();
    const board: BoardState = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, frames: [], windows: [], panel: { open: true, width: 320 }, savedAt: '' };
    registry.register('board', { load: async () => board });
    registry.register('terminals', { list: async () => [] });
    registry.register('status', { snapshot: async () => [] });
    registry.register('workspaces', { list: async () => [] });
    const notes: unknown[] = [];
    const asked: unknown[] = [];
    const server = await startAppMcp({
      registry,
      emit: () => {},
      homeDir: home,
      port: 0,
      onNotify: (n) => notes.push(n),
      confirm: async (q) => {
        asked.push(q);
        return false;
      },
    });
    try {
      const token = readFileSync(join(home, '.agentdeck/run/mcp-token'), 'utf8').trim();
      const call = async (name: string, args: object = {}) => {
        const res = await fetch(server.endpoint.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        });
        return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
      };
      expect(JSON.parse((await call('list_windows')).content[0]!.text)).toEqual({ windows: [] });
      await call('notify', { message: 'Tests passed' });
      expect(notes).toEqual([{ terminalId: null, message: 'Tests passed' }]);
      expect(await call('open_terminals', { count: 7, workspace_id: null })).toMatchObject({ isError: true });
      expect(asked).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('startAppMcp · AH11', () => {
  it('terminals whose window has Hide from agents (saved board) are not listed, read or typed into; commands are redacted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-mcp-'));
    dirs.push(home);
    const registry = createServiceRegistry();
    const termWindow = (id: string, terminalId: string, hideFromAgents?: boolean) =>
      ({
        id,
        type: 'terminal',
        workspaceId: null,
        position: { x: 0, y: 0 },
        size: { width: 600, height: 400 },
        data: { terminalId, agent: 'shell', cmd: 'zsh', args: [], cwd: '/repo', sessionId: null, startCommand: null, ...(hideFromAgents !== undefined ? { hideFromAgents } : {}) },
      }) as unknown as BoardState['windows'][number];
    const board: BoardState = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      frames: [],
      windows: [termWindow('win-db', 'term-db', true), termWindow('win-pg', 'term-pg', false)],
      panel: { open: true, width: 320 },
      savedAt: '',
    };
    const info = (id: string, command: string) => ({ id, command, cwd: '/repo', alive: true, exitCode: null }) as unknown as TerminalInfo;
    const reads: string[] = [];
    const sent: string[] = [];
    registry.register('board', { load: async () => board });
    registry.register('terminals', {
      list: async () => [info('term-db', 'harlequin'), info('term-pg', 'pgcli postgres://app:secret@db.internal/shop')],
      lastLines: async (id: string) => {
        reads.push(id);
        return ['x'];
      },
      sendKeys: async (id: string) => {
        sent.push(id);
      },
    });
    registry.register('status', { snapshot: async () => [] });
    registry.register('workspaces', { list: async () => [] });
    const server = await startAppMcp({ registry, emit: () => {}, homeDir: home, port: 0 });
    try {
      const token = readFileSync(join(home, '.agentdeck/run/mcp-token'), 'utf8').trim();
      const call = async (name: string, args: object = {}) => {
        const res = await fetch(server.endpoint.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        });
        return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
      };
      const listed = JSON.parse((await call('list_terminals')).content[0]!.text) as { terminals: { id: string; command: string }[] };
      expect(listed.terminals.map((t) => [t.id, t.command])).toEqual([['term-pg', 'pgcli postgres://app:***@db.internal/shop']]);
      const hidden = { isError: true, content: [{ text: 'The user hid this terminal from agents' }] };
      expect(await call('read_terminal', { terminal_id: 'term-db' })).toMatchObject(hidden);
      expect(await call('send_to_terminal', { terminal_id: 'term-db', text: 'drop table users' })).toMatchObject(hidden);
      expect(reads).toEqual([]);
      expect(sent).toEqual([]);
      expect((await call('read_terminal', { terminal_id: 'term-pg' })).isError).toBeUndefined();
      expect(reads).toEqual(['term-pg']);
    } finally {
      await server.close();
    }
  });
});

describe('writeMcpPluginDir', () => {
  it('writes the fixed plugin folder omp loads with --plugin-dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-plugin-'));
    dirs.push(dir);
    expect(await writeMcpPluginDir(join(dir, 'mcp-plugin'))).toBe(join(dir, 'mcp-plugin'));
    const manifest = JSON.parse(readFileSync(join(dir, 'mcp-plugin/.claude-plugin/plugin.json'), 'utf8'));
    expect(manifest.mcpServers.agentdeck.url).toBe('${AGENTDECK_MCP_URL}');
    // 再写一遍（每次启动）不出错
    await writeMcpPluginDir(join(dir, 'mcp-plugin'));
  });
});
