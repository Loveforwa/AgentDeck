// 额度上限（插件 Auto-resume · PL5）：认出被打断、按账号归组、错开续跑。只在主进程里用。

export { LimitServiceImpl } from './service.ts';
export type { LimitServiceOptions, LimitTarget } from './service.ts';
export {
  accountKey,
  claudeSelfResumes,
  CODEX_SUBAGENT_LINE,
  DEFAULT_RESUME_PROMPT,
  effectiveAutoResume,
  hasQueuedPrompts,
  KEEP_AWAKE_WITHIN_MS,
  LIMIT_AGENTS,
  limitConfigDir,
  limitScopeOf,
  lostSubagents,
  MAX_REHITS,
  RESUME_GRACE_MS,
  RESUME_STAGGER_MS,
  resumePromptText,
  scopeMatches,
  SELF_RESUME_FALLBACK_MS,
  SELF_RESUME_SINCE,
  SLEPT_AFTER_MS,
  subagentSection,
} from './rules.ts';
export type { ResumePromptInput } from './rules.ts';
