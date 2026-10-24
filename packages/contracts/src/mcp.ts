// AgentDeck 自己的 MCP 服务（M1）：白板里的 agent 通过它开终端、开工作区、开网页、看和指挥别的终端。
// 服务跑在主进程（HTTP，只听 127.0.0.1），实现：packages/mcp-server；挂到 agent 上：packages/agent-adapters（claude、codex、omp；N1 起，见它的 AGENTS.md）。

/** agent 配置里这个 MCP 服务的名字，claude 里的工具名是 mcp__agentdeck__<工具名>。 */
export const MCP_SERVER_NAME = 'agentdeck';

/**
 * 放 MCP token 的环境变量。token 只放在终端环境里，不写进命令行（ps 能看到别的用户进程的命令行）；
 * agent 的 MCP 配置里写 `${AGENTDECK_MCP_TOKEN}`，由 agent 自己展开（claude 2.1.291 实测会展开）。
 */
export const MCP_TOKEN_ENV = 'AGENTDECK_MCP_TOKEN';

/** 请求头：发起调用的终端 id，配置里写 `${AGENTDECK_TERM}`。服务据此知道调用者在哪个工作区。 */
export const MCP_TERMINAL_HEADER = 'x-agentdeck-terminal';

/** 启动 agent 时要挂上的 MCP 服务。 */
export interface McpEndpoint {
  /** 例如 http://127.0.0.1:47621/mcp */
  url: string;
  /** 放进 MCP_TOKEN_ENV 的值。 */
  token: string;
}
