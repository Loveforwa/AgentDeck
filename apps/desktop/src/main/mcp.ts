// AgentDeck 的 MCP 服务（M1、N1）：packages/mcp-server 起在主进程，工具通过注册表调服务，和界面走同一套实现。
// 还没注册的服务（组装前）调用时是 not-found，工具返回 “Service not available: …”。

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentDeckError } from '@agentdeck/contracts';
import type { AgentDeckEvent, ServiceName, Services, TerminalId, WorkspaceId } from '@agentdeck/contracts';
import { mcpPluginFiles } from '@agentdeck/agent-adapters';
import { loadOrCreateToken, startMcpServer } from '@agentdeck/mcp-server';
import type { McpHttpServer, McpToolDeps } from '@agentdeck/mcp-server';
import { isErrorEnvelope } from '../shared/wire.ts';
import type { ServiceRegistry } from './registry.ts';

/** MCP 发起的调用不来自任何窗口。webContents.id 从 1 开始，0 不会和真窗口撞上。 */
export const MCP_SENDER_ID = 0;

/** 照注册表调一个服务：结果原样返回，{ error } 还原成 AgentDeckError 抛出。 */
export function viaRegistry<S extends ServiceName>(registry: ServiceRegistry, service: S): Services[S] {
  return new Proxy({} as Services[S], {
    get: (_target, method) =>
      typeof method !== 'string'
        ? undefined
        : async (...args: unknown[]) => {
            const result = await registry.invoke({ service, method, args }, { senderId: MCP_SENDER_ID });
            if (isErrorEnvelope(result)) throw new AgentDeckError(result.error);
            return result;
          },
  });
}

export interface AppMcpOptions {
  registry: ServiceRegistry;
  emit: (event: AgentDeckEvent) => void;
  /** 默认 ~/.agentdeck/run/mcp-token。 */
  tokenPath?: string;
  homeDir?: string;
  port?: number;
  /** 组装时接 StatusMachine.get(id)?.workspaceId。 */
  workspaceOf?: (terminalId: TerminalId) => WorkspaceId | null | undefined;
  /** 组装时接 AgentRuntime.noteInput。 */
  onInput?: (terminalId: TerminalId) => void;
  /** N1：open_terminals 一次超过 6 个时问用户（组装时接系统对话框）。 */
  confirm?: McpToolDeps['confirm'];
  /** N1：notify 工具发了通知（组装时在应用不在前台时发系统通知）。 */
  onNotify?: McpToolDeps['onNotify'];
}

export async function startAppMcp(opts: AppMcpOptions): Promise<McpHttpServer> {
  const home = opts.homeDir ?? homedir();
  const { registry } = opts;
  return startMcpServer({
    token: await loadOrCreateToken(opts.tokenPath ?? join(home, '.agentdeck/run/mcp-token')),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    projects: viaRegistry(registry, 'projects'),
    workspaces: viaRegistry(registry, 'workspaces'),
    agents: viaRegistry(registry, 'agents'),
    terminals: viaRegistry(registry, 'terminals'),
    status: viaRegistry(registry, 'status'),
    // N1：list_windows、focus_window 读保存的白板（界面改动后半秒保存）
    board: viaRegistry(registry, 'board'),
    emit: opts.emit,
    homeDir: home,
    ...(opts.workspaceOf ? { workspaceOf: opts.workspaceOf } : {}),
    ...(opts.onInput ? { onInput: opts.onInput } : {}),
    ...(opts.confirm ? { confirm: opts.confirm } : {}),
    ...(opts.onNotify ? { onNotify: opts.onNotify } : {}),
    onError: (e) => console.error('[agentdeck:mcp]', e),
  });
}

/**
 * N1：把 AgentDeck 的 MCP 插件目录（agent-adapters 的 mcpPluginFiles，omp 用 --plugin-dir 加载）写进 dir，返回 dir。
 * 内容是固定的（url、token 都是 `${环境变量}`），每次启动覆盖一遍，升级后跟着变。
 */
export async function writeMcpPluginDir(dir: string): Promise<string> {
  for (const [rel, content] of Object.entries(mcpPluginFiles())) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}
