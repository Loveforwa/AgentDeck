// 白板上能直接开的 agent。

import type { AgentInfo } from '@agentdeck/contracts';

/**
 * 装好了、而且不用再问什么就能启动的 agent。“自定义命令”（custom）要先问命令是什么，白板还没有这个对话框，
 * 直接选会以没有命令启动失败，所以不列（IS-21）。
 */
export function startableAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.installed && a.id !== 'custom');
}
