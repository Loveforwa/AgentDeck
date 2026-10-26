// agent 自带的后台子 agent（MVP v3 · N10，DR-61）。只在主进程里用。

export { SUBAGENT_AGENTS, SubagentServiceImpl } from './service.ts';
export type { SubagentServiceOptions } from './service.ts';
export {
  ClaudeTranscriptParser,
  claudeSubagentFile,
  isClaudeSyntheticPrompt,
  parseClaudeBackgroundTasks,
  parseClaudeSubagentMeta,
  parseClaudeTaskNotification,
} from './claude.ts';
