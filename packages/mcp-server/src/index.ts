export { handleCli, notAvailable, parseArgs } from './cli.ts';
export type { CliDeps, CliServiceDeps } from './cli.ts';
export { agentTerminalRefusal, assertAgentTerminalAccess, HIDDEN_FROM_AGENTS_MESSAGE, hiddenTerminalIds, WAITING_FOR_USER_MESSAGE } from './guard.ts';
export type { AgentTerminalAccess, AgentTerminalTarget } from './guard.ts';
export { DEFAULT_MCP_PORT, loadOrCreateToken, startMcpServer, terminalKey } from './server.ts';
export type { McpHttpServer, McpHttpServerOptions } from './server.ts';
export {
  AGENTDECK_MCP_ITEM_ID,
  browserTarget,
  callTool,
  estimateInjection,
  LEAD_ONLY_TOOLS,
  literalKeys,
  MAX_TERMINALS_PER_CALL,
  MAX_TERMINALS_WITHOUT_CONFIRM,
  registerTools,
  SERVER_INSTRUCTIONS,
  TOOLS,
} from './tools.ts';
export type { McpCaller, McpToolDeps, RegisterToolsOptions, ToolDef, ToolOutcome } from './tools.ts';
