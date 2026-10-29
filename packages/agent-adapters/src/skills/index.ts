// Skills · MCP（N9）：库、仓库里的 skill、每种 agent 怎么带、SkillsService。
export {
  builtinSkillFiles,
  listSkillFolders,
  mcpDetail,
  mcpItemId,
  parseMcpFile,
  parseSkillFrontmatter,
  readSkillFolder,
  SkillLibrary,
  skillItemId,
} from './library.ts';
export type { SkillFrontmatter, SkillLibraryDirs } from './library.ts';
export { findRepoRoot, scanRepoSkills } from './repo.ts';
export { notSupportedNote, skillsSupport } from './support.ts';
export type { McpMethod, SkillsMethod, SkillsSupport } from './support.ts';
export { AGENTDECK_MCP_ID, agentdeckMcpItem, SKILL_SETS_CLEANUP_INTERVAL_MS, SKILL_SETS_MAX_AGE_MS, setManifest, SkillsServiceImpl } from './service.ts';
export type { PrepareLaunchRequest, SkillSetsCleanup, SkillsServiceOptions } from './service.ts';
export { SKILL_SET_PLUGIN_NAME } from './types.ts';
export type { LaunchSkills, McpServerDef } from './types.ts';
