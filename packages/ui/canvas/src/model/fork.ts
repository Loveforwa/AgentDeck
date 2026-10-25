// X4 · Fork 对话：一个终端能不能把对话复制到别的工作区，不能时为什么（菜单、W5 对话框里灰掉并写原因）。

import type { AgentInfo, AgentSessionId, StatusSnapshot, TerminalWindowData, WindowNode } from '@agentdeck/contracts';
import { isAgentTerminal, isTerminal } from './windows.ts';

export type ForkCheck = { ok: true; sessionId: AgentSessionId } | { ok: false; reason: string };

/**
 * null：不是 agent 终端（shell、自定义命令、网页），根本不提供 Fork。
 * 会话 id 优先用窗口数据里的（终端组件收到 status.changed 后写回），其次用状态快照里的（codex、omp 的 id 是钩子后来报的）。
 * 还没说过话的会话（id 有了、文件还没写）这里看不出来，由 agents.start 报 “No conversation to fork yet”。
 */
export function forkCheck(
  node: WindowNode,
  agents: readonly AgentInfo[],
  statuses: Readonly<Record<string, StatusSnapshot>>,
): ForkCheck | null {
  if (!isTerminal(node) || !isAgentTerminal(node)) return null;
  const data = node.data as Partial<TerminalWindowData>;
  const info = agents.find((a) => a.id === data.agent);
  const label = info?.label || data.agent || 'This agent';
  if (!info || !info.capabilities.fork) return { ok: false, reason: `${label} can't fork a conversation` };
  if (!info.installed) return { ok: false, reason: `${label} is not installed` };
  const sessionId = data.sessionId ?? (data.terminalId ? statuses[data.terminalId]?.sessionId : null) ?? null;
  if (!sessionId) return { ok: false, reason: 'No conversation to fork yet' };
  return { ok: true, sessionId };
}
