// 内置适配器。claude、codex、Shell、自定义命令各有一个文件；其他 agent 登记在已知表（known.ts），由通用适配器读。

import type { AdapterDeps, AgentAdapterExt } from './types.ts';
import { ClaudeAdapter } from './claude.ts';
import type { CodexAdapterOptions } from './codex.ts';
import { CodexAdapter } from './codex.ts';
import type { KnownAgentAdapterOptions } from './generic.ts';
import { KnownAgentAdapter } from './generic.ts';
import { KNOWN_AGENTS } from './known.ts';
import { CustomCommandAdapter, ShellAdapter } from './shell.ts';

export function createDefaultAdapters(
  deps: AdapterDeps & Pick<CodexAdapterOptions, 'queryTrust'> & Pick<KnownAgentAdapterOptions, 'agentExtension' | 'mcpPluginDir'>,
): AgentAdapterExt[] {
  return [
    new ClaudeAdapter(deps),
    new CodexAdapter(deps),
    ...KNOWN_AGENTS.map((def) => new KnownAgentAdapter(def, deps)),
    new ShellAdapter(deps),
    new CustomCommandAdapter(),
  ];
}
