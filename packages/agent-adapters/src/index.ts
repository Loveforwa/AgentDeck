// @agentdeck/agent-adapters：agent 适配器、AgentService、钩子 socket、状态机、后台通知规则。只在主进程里用。

export { createAgentRuntime, strategyFromReport } from './runtime.ts';
export type { AgentRuntime, AgentRuntimeOptions } from './runtime.ts';
export { AgentServiceImpl, PENDING_TERMINAL_ID } from './agent-service.ts';
export type { AgentServiceOptions, StartedAgent } from './agent-service.ts';
export { createDefaultAdapters } from './adapters/index.ts';
export { conversationCheckFromEnv, conversationExists } from './fork.ts';
export type { ConversationCheck } from './fork.ts';
export { ClaudeAdapter, claudeHookEvents, claudeHookSettings, claudeMcpConfig } from './adapters/claude.ts';
export {
  CODEX_HOOK_EVENTS,
  CodexAdapter,
  codexHookOverrides,
  codexLibraryMcpOverrides,
  codexMcpOverrides,
  parseHooksList,
  queryTrustViaAppServer,
} from './adapters/codex.ts';
export { MCP_URL_ENV, mcpPluginFiles } from './adapters/mcp-plugin.ts';
export type { CodexAdapterOptions, CodexHookTrust, CodexTrustQuery } from './adapters/codex.ts';
export { KnownAgentAdapter } from './adapters/generic.ts';
export type { KnownAgentAdapterOptions } from './adapters/generic.ts';
export { EXTENSION_ENV, KNOWN_AGENTS } from './adapters/known.ts';
export type { KnownAgent } from './adapters/known.ts';
export { CustomCommandAdapter, ShellAdapter } from './adapters/shell.ts';
export type { CommandLaunchContext } from './adapters/shell.ts';
export type { AdapterDeps, AdapterLaunchContext, AgentAdapterExt, LaunchFlag } from './adapters/types.ts';
export { atLeast, compareVersions, fileStamp, findExecutable, helpHasFlag, readHelp, readVersion, shellQuote, splitCommand } from './env.ts';
export type { Env, EnvSource } from './env.ts';
export { hookHint, parseClaudeNotification, parseClaudeStopFailure, parseCommonHook, parsePermissionRequest, parseSessionStart, sessionStartReason } from './hook-payload.ts';
export { defaultHookSocketPath, HookServer, parseEnvelope } from './hook-server.ts';
export type { HookServerOptions, ReceivedHook } from './hook-server.ts';
export { HOOKS_DIDNT_REPORT, StatusMachine } from './status/machine.ts';
// AH0 / AH2 / AH3：能力声明、合格测试记录、报告
export { no, partial, yes } from './capabilities/declare.ts';
export { buildReport, newerThanChecked, verifiedUpTo } from './capabilities/report.ts';
export type { BuildReportInput, RuntimeNotes } from './capabilities/report.ts';
export { COMPAT_RECORDS } from './compat/records.ts';
export { CONFORMANCE_AGENTS, SCENARIOS, scenariosFor } from './compat/scenarios.ts';
export type { Scenario, ScenarioId } from './compat/scenarios.ts';
export type { CompatItem, CompatRecord, CompatResult } from './compat/types.ts';
export { FirstMessageTyper, literalKeys, plainText } from './first-message.ts';
// contracts 0.1.22：最后一条回复（AgentService.lastReply、CrewService.result）
export { createLastReply, lastReplyFromLines, readLastReply, REPLY_AGENTS, replyFromScreenLines } from './replies/index.ts';
export type { LastReplyOptions, TranscriptReply } from './replies/index.ts';
export type { HookHint, StatusMachineOptions, TrackedTerminal, TrackOptions } from './status/machine.ts';
export { ApprovalServiceImpl } from './status/approval.ts';
export type { ApprovalRecordStore, ApprovalServiceOptions, ApprovalStatusSource, ApprovalTiming } from './status/approval.ts';
export { AutoApproveScopes } from './status/auto-approve.ts';
export { matchApprovalScreen, matchOmpApproval } from './status/screens.ts';
export type { ScreenKind, ScreenPrompt } from './status/screens.ts';
export { approvalStrategy, autoApproveSupport } from './status/support.ts';
export type { ApprovalStrategy } from './status/support.ts';
export { compilePatterns, DEFAULT_DESTRUCTIVE_PATTERNS, isDestructive } from './status/destructive.ts';
export { backgroundAlerts, badgeCount, isWaiting } from './background-alerts.ts';
export type { AlertInput, AlertOutput, SystemNotification } from './background-alerts.ts';
export {
  CLAUDE_WINDOWS,
  ClaudeUsageParser,
  claudeProjectDirName,
  claudeWindow,
  CodexUsageParser,
  codexRetryAt,
  claudeLimitOf,
  defaultUsageRoots,
  JsonlTail,
  KimiUsageParser,
  locateClaude,
  locateCodex,
  locateKimi,
  locatePi,
  parseKimiConfig,
  parseKimiIndex,
  PiUsageParser,
  USAGE_AGENTS,
  USAGE_HOOK,
  UsageServiceImpl,
} from './usage/index.ts';
export type { KimiQuery, Located, ParsedUsage, UsageParser, UsageRoots, UsageServiceOptions, UsageTarget } from './usage/index.ts';
export {
  ClaudeTranscriptParser,
  claudeSubagentFile,
  isClaudeSyntheticPrompt,
  parseClaudeBackgroundTasks,
  parseClaudeSubagentMeta,
  parseClaudeTaskNotification,
  SUBAGENT_AGENTS,
  SubagentServiceImpl,
} from './subagents/index.ts';
export type { SubagentServiceOptions } from './subagents/index.ts';
export { HistoryServiceImpl, oneLine, parseCodexIndex, parseKimiState, readClaudeSession, readCodexSession, readPiSession } from './history/index.ts';
export type { CodexIndex, HistoryServiceOptions, ParsedSession } from './history/index.ts';
export {
  AGENTDECK_MCP_ID,
  agentdeckMcpItem,
  builtinSkillFiles,
  findRepoRoot,
  listSkillFolders,
  mcpDetail,
  mcpItemId,
  notSupportedNote,
  parseMcpFile,
  parseSkillFrontmatter,
  readSkillFolder,
  scanRepoSkills,
  setManifest,
  SKILL_SET_PLUGIN_NAME,
  SKILL_SETS_CLEANUP_INTERVAL_MS,
  SKILL_SETS_MAX_AGE_MS,
  SkillLibrary,
  skillItemId,
  SkillsServiceImpl,
  skillsSupport,
} from './skills/index.ts';
export type {
  LaunchSkills,
  McpMethod,
  McpServerDef,
  PrepareLaunchRequest,
  SkillFrontmatter,
  SkillLibraryDirs,
  SkillSetsCleanup,
  SkillsMethod,
  SkillsServiceOptions,
  SkillsSupport,
} from './skills/index.ts';
export {
  accountKey,
  claudeSelfResumes,
  CODEX_SUBAGENT_LINE,
  DEFAULT_RESUME_PROMPT,
  effectiveAutoResume,
  LIMIT_AGENTS,
  limitConfigDir,
  limitScopeOf,
  LimitServiceImpl,
  resumePromptText,
  RESUME_GRACE_MS,
  RESUME_STAGGER_MS,
} from './limits/index.ts';
export type { LimitServiceOptions, LimitTarget, ResumePromptInput } from './limits/index.ts';
