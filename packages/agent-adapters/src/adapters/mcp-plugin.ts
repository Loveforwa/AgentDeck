// AgentDeck 的 MCP 插件目录（N1）：给只能从“插件目录”读 MCP 配置的 agent（omp 的 --plugin-dir）用。
// 内容是固定的：url、token、终端 id 都写成 `${环境变量}`，由 agent 读配置时展开，所以目录只要组装时写一次
// （例如 ~/.agentdeck/mcp-plugin），端口变了、token 换了都不用重写；token 不落盘、不进命令行。
// 本包不写文件：组装方（apps/desktop）把 mcpPluginFiles() 写进自己的目录，再把目录传给 createAgentRuntime。

import { MCP_SERVER_NAME, MCP_TERMINAL_HEADER, MCP_TOKEN_ENV, TERMINAL_ID_ENV } from '@agentdeck/contracts';

/** 插件清单里 url 读的环境变量（LaunchSpec.env 带上 McpEndpoint.url）。 */
export const MCP_URL_ENV = 'AGENTDECK_MCP_URL';

/**
 * 插件目录里的文件：相对路径 → 内容。Claude 插件格式（omp 认 `.claude-plugin/plugin.json`），
 * MCP 服务内联在清单的 mcpServers 里。omp 里这个服务叫 `agentdeck:agentdeck`（插件名:服务名）。
 */
export function mcpPluginFiles(): Record<string, string> {
  const manifest = {
    name: MCP_SERVER_NAME,
    description: 'AgentDeck board tools: open terminals and browser windows next to you, list windows, notify the user.',
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: `\${${MCP_URL_ENV}}`,
        headers: {
          Authorization: `Bearer \${${MCP_TOKEN_ENV}}`,
          [MCP_TERMINAL_HEADER]: `\${${TERMINAL_ID_ENV}}`,
        },
      },
    },
  };
  return { '.claude-plugin/plugin.json': `${JSON.stringify(manifest, null, 2)}\n` };
}
