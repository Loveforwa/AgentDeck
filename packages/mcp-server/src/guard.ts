// agent 能不能碰一个终端（AH7、IS-102；AH11、IS-129）：所有“agent 往别的终端里看、打字”的入口都走这一处判断，
// 现在是 MCP 的 send_to_terminal；以后 agentdeck 命令行（CR14 的 /cli）和 Flow 窗口的 Ask <agent> about this step…（CU2）
// 也用它，免得各处规则不一样。只看传进来的状态，不调服务，所以哪里都能用。

import { AgentDeckError, WAITING_STATUSES } from '@agentdeck/contracts';
import type { BoardState, StatusSnapshot, TerminalId, TerminalWindowData } from '@agentdeck/contracts';

/** agent 要对终端做什么：read 读屏幕，send 打字。 */
export type AgentTerminalAccess = 'read' | 'send';

/** 判断要用的目标终端的情况。 */
export interface AgentTerminalTarget {
  /** 目标的当前状态；不知道时为 undefined（不挡）。 */
  status: Pick<StatusSnapshot, 'status'> | undefined;
  /** 用户勾了 Hide from agents（TerminalWindowData.hideFromAgents，AH11）。 */
  hidden: boolean;
}

export const WAITING_FOR_USER_MESSAGE = 'This terminal is waiting for the user. Use the inbox.';
export const HIDDEN_FROM_AGENTS_MESSAGE = 'The user hid this terminal from agents';

/**
 * 不许时返回要报的错（code invalid-argument，2026-10-28 定：不加新的错误码），许可时返回 null。先看隐藏，再看状态。
 * - 隐藏的终端（Hide from agents）读和打字都不许：数据库 TUI 屏幕上的数据、往里打的 SQL 都不该经过 agent。
 *   列表里也不列（调用方自己过滤，用 hiddenTerminalIds）。
 * - send：目标在等你（needs-approval、needs-reply）时不许打字。往停在批准提示上的终端打 “1” 加回车，等于替人按了批准，
 *   绕过收件箱、破坏性名单和 ApprovalRecord。回答要走收件箱。
 * - read：只挡隐藏的。
 */
export function agentTerminalRefusal(access: AgentTerminalAccess, target: AgentTerminalTarget): AgentDeckError | null {
  if (target.hidden) return new AgentDeckError({ code: 'invalid-argument', message: HIDDEN_FROM_AGENTS_MESSAGE });
  if (access === 'send' && target.status && WAITING_STATUSES.includes(target.status.status)) {
    return new AgentDeckError({ code: 'invalid-argument', message: WAITING_FOR_USER_MESSAGE });
  }
  return null;
}

/** 同 agentTerminalRefusal，不许时直接抛出。 */
export function assertAgentTerminalAccess(access: AgentTerminalAccess, target: AgentTerminalTarget): void {
  const refusal = agentTerminalRefusal(access, target);
  if (refusal) throw refusal;
}

/** 白板上勾了 Hide from agents 的终端（组装时从保存的白板算，交给 McpToolDeps.hiddenFromAgents）。 */
export function hiddenTerminalIds(board: Pick<BoardState, 'windows'>): Set<TerminalId> {
  const ids = new Set<TerminalId>();
  for (const w of board.windows) {
    if (w.type !== 'terminal' || !w.data) continue;
    const d = w.data as Partial<TerminalWindowData>;
    if (d.hideFromAgents === true && d.terminalId) ids.add(d.terminalId);
  }
  return ids;
}
