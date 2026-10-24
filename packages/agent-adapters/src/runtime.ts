// 把本包的几块接在一起，给组装阶段（apps/desktop 主进程）一个入口：
//   AgentService ─onStarted→ StatusMachine.track
//   HookServer ─onHook→ StatusMachine.onHook
//   TerminalHost 的事件 → onTerminalEvent；IPC 层的 terminals.write / sendKeys → noteInput
// 组装时把 agents / status / approvals 挂到 IPC 上，emit 接到事件通道。

import type { AbsPath, AgentKind, McpEndpoint, StatusEvent, TerminalEvent, TerminalHost, TerminalId } from '@agentdeck/contracts';
import { createDefaultAdapters } from './adapters/index.ts';
import type { AgentAdapterExt } from './adapters/types.ts';
import { AgentServiceImpl } from './agent-service.ts';
import type { EnvSource } from './env.ts';
import { hookHint } from './hook-payload.ts';
import type { HookServerOptions } from './hook-server.ts';
import { HookServer } from './hook-server.ts';
import { ApprovalServicePlaceholder } from './status/approval.ts';
import { StatusMachine } from './status/machine.ts';

export interface AgentRuntimeOptions {
  /** 登录 shell 的环境。 */
  env: EnvSource;
  terminals: Pick<TerminalHost, 'create'>;
  /** agentdeck-notify 的绝对路径。 */
  notifyCommand: AbsPath;
  /** agentdeck-pi-extension.mjs 的绝对路径（pi、omp 用 -e 加载它拿状态）。不给时它们没有钩子。 */
  agentExtension?: AbsPath;
  emit: (event: StatusEvent) => void;
  /** Settings › Approvals › destructivePatterns。 */
  destructivePatterns: () => readonly string[];
  /** Settings › Agents › extraArgs。 */
  extraArgs?: (agent: AgentKind) => string[];
  /** AgentDeck 的 MCP 服务（M1），见 AgentServiceOptions.mcp。 */
  mcp?: () => McpEndpoint | null;
  /** 默认 ~/.agentdeck/run/hooks.sock。 */
  socketPath?: string;
  /** 默认 createDefaultAdapters。 */
  adapters?: AgentAdapterExt[];
  decide?: HookServerOptions['decide'];
  now?: () => Date;
}

export function createAgentRuntime(opts: AgentRuntimeOptions) {
  const adapters =
    opts.adapters ?? createDefaultAdapters({ env: opts.env, ...(opts.agentExtension ? { agentExtension: opts.agentExtension } : {}) });
  const status = new StatusMachine({
    emit: opts.emit,
    destructivePatterns: opts.destructivePatterns,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const agents = new AgentServiceImpl({
    adapters,
    terminals: opts.terminals,
    env: opts.env,
    notifyCommand: opts.notifyCommand,
    ...(opts.extraArgs ? { extraArgs: opts.extraArgs } : {}),
    ...(opts.mcp ? { mcp: opts.mcp } : {}),
    onStarted: (s) =>
      status.track(s.terminalId, { agent: s.agent, workspaceId: s.workspaceId, hooks: s.hooks, sessionId: s.sessionId }),
  });
  const hookServer = new HookServer({
    ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
    adapterFor: (agent) => agents.adapter(agent),
    onHook: (h) => status.onHook(h.terminalId, h.event, hookHint(h.hookName, h.envelope.payload)),
    ...(opts.decide ? { decide: opts.decide } : {}),
  });
  return {
    agents,
    status,
    approvals: new ApprovalServicePlaceholder(),
    hookServer,
    onTerminalEvent: (event: TerminalEvent) => status.onTerminalEvent(event),
    noteInput: (terminalId: TerminalId) => status.noteInput(terminalId),
    start: () => hookServer.start(),
    close: () => hookServer.close(),
  };
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
