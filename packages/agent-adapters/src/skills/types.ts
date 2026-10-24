// Skills · MCP（N9）在本包里的类型。contracts 只有给界面的形状（SkillsService），这里是启动时要用的。

import type { AbsPath, SkillItemId } from '@agentdeck/contracts';

/** 库里的一个 MCP 服务（<库>/mcp/<name>.json）。 */
export type McpServerDef =
  | { name: string; transport: 'stdio'; command: string; args: string[] }
  | { name: string; transport: 'http'; url: string };

/** 这次启动带什么。由 SkillsServiceImpl.prepareLaunch 算出，经 AgentService 交给适配器（AdapterLaunchContext.skills）。 */
export interface LaunchSkills {
  /** 这次真的带上的、能开关的项（built-in 和 library），记成这个终端的 running。 */
  ids: SkillItemId[];
  /** built-in 的 agentdeck MCP 勾着没有。没勾时不挂 AgentDeck 的 MCP（LaunchContext.mcp 不给）。 */
  agentdeckMcp: boolean;
  /** 选中的 skill（built-in 和 library），每个是一个有 SKILL.md 的文件夹。pi 用 --skill 直接指它们。 */
  skills: { name: string; path: AbsPath }[];
  /** 选中的库里的 MCP 服务。 */
  mcp: McpServerDef[];
  /**
   * 写好的一套目录（claude、omp、kimi）：`skills/<name>/` 是选中 skill 的副本，`.claude-plugin/plugin.json` 是插件清单
   * （omp 的清单里还有库里的 MCP）。claude、omp 用 --plugin-dir 加载整个目录，kimi 用 --skills-dir 指 `skills/`。没有要带的时为 null。
   */
  setDir: AbsPath | null;
  /**
   * kimi：--skills-dir 会顶掉它自己发现的用户、项目目录，所以把这些目录（存在的）一起传回去。别的 agent 为空。
   */
  keepSkillRoots: AbsPath[];
}

/** 插件清单的名字。claude 里 skill 显示成 agentdeck-skills:<name>，omp 里 MCP 服务是 agentdeck-skills:<name>。 */
export const SKILL_SET_PLUGIN_NAME = 'agentdeck-skills';
