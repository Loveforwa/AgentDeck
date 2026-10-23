// 内置适配器。加一个 agent：新建一个文件实现 AgentAdapterExt，再在这里加一行。

import type { AdapterDeps, AgentAdapterExt } from './types.ts';
import { ClaudeAdapter } from './claude.ts';
import type { CodexAdapterOptions } from './codex.ts';
import { CodexAdapter } from './codex.ts';
import { CustomCommandAdapter, ShellAdapter } from './shell.ts';

export function createDefaultAdapters(deps: AdapterDeps & Pick<CodexAdapterOptions, 'queryTrust'>): AgentAdapterExt[] {
  return [new ClaudeAdapter(deps), new CodexAdapter(deps), new ShellAdapter(deps), new CustomCommandAdapter()];
}
