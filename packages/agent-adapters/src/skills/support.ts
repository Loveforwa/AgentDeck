// 每种 agent 怎么带 skill 和 MCP（N9）。只用启动参数和环境变量，不写用户自己的配置、不往仓库里放文件。
// claude、codex 写在这里，pi、omp、kimi 读已知 agent 表（known.ts 的 skills、mcp 两列）。核对记录见 AGENTS.md「Skills · MCP」。

import type { AgentKind } from '@agentdeck/contracts';
import { KNOWN_AGENTS } from '../adapters/known.ts';

export type SkillsMethod = 'plugin-dir' | 'skill-flag' | 'skills-dir';
export type McpMethod = 'mcp-config' | 'codex-config' | 'plugin-dir';

export interface SkillsSupport {
  /** 库里（和 built-in）的 skill 怎么带。null = 带不了。 */
  skills: SkillsMethod | null;
  /** MCP（built-in 的 agentdeck 和库里的）怎么挂。null = 挂不了。 */
  mcp: McpMethod | null;
  /** 仓库里它自己会读的 skill 目录（相对），从 cwd 往上找到仓库根。 */
  repoDirs: string[];
}

const NONE: SkillsSupport = { skills: null, mcp: null, repoDirs: [] };

export function skillsSupport(agent: AgentKind): SkillsSupport {
  switch (agent) {
    case 'claude':
      // skill：--plugin-dir（2.1.291 `claude --plugin-dir <目录> plugin details agentdeck-skills` 列出 Skills (1)）；
      // MCP：--mcp-config，和用户自己的合并（M1）。仓库里读 .claude/skills（从 cwd 往上）。
      return { skills: 'plugin-dir', mcp: 'mcp-config', repoDirs: ['.claude/skills'] };
    case 'codex':
      // MCP：-c mcp_servers.<名>.*（N1）。skill：0.164.0 没有启动参数能加 skill 目录——skills.config 只开关已经发现的
      // （app-server skills/list 实测），加目录只有 app-server 的 skills/extraRoots/set，TUI 用不上。仓库里读 .agents/skills、.codex/skills。
      return { skills: null, mcp: 'codex-config', repoDirs: ['.agents/skills', '.codex/skills'] };
    default: {
      const known = KNOWN_AGENTS.find((a) => a.id === agent);
      if (!known) return NONE;
      return { skills: known.skills?.kind ?? null, mcp: known.mcp ? 'plugin-dir' : null, repoDirs: known.skills?.repoDirs ?? [] };
    }
  }
}

/** 面板上不能勾时的说明。 */
export function notSupportedNote(agent: AgentKind): string {
  return `Not supported for ${agent}`;
}
