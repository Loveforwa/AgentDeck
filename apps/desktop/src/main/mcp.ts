// AgentDeck 的 MCP 服务（M1）：packages/mcp-server 起在主进程，工具通过注册表调服务，和界面走同一套实现。
// 还没注册的服务（组装前）调用时是 not-found，工具返回 “Service not available: …”。

import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentDeckError } from '@agentdeck/contracts';
import type { AgentDeckEvent, ServiceName, Services, TerminalId, WorkspaceId } from '@agentdeck/contracts';
import { loadOrCreateToken, startMcpServer } from '@agentdeck/mcp-server';
import type { McpHttpServer } from '@agentdeck/mcp-server';
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
    emit: opts.emit,
    homeDir: home,
    ...(opts.workspaceOf ? { workspaceOf: opts.workspaceOf } : {}),
    ...(opts.onInput ? { onInput: opts.onInput } : {}),
    onError: (e) => console.error('[agentdeck:mcp]', e),
  });
}
