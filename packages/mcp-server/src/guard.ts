// agent 能不能碰一个终端（AH7、IS-102）：所有“agent 往别的终端里看、打字”的入口都走这一处判断，
// 现在是 MCP 的 send_to_terminal；以后 agentdeck 命令行（CR14 的 /cli）和 Flow 窗口的 Ask <agent> about this step…（CU2）
// 也用它，免得各处规则不一样。只看传进来的状态，不调服务，所以哪里都能用。

import { AgentDeckError, WAITING_STATUSES } from '@agentdeck/contracts';
import type { StatusSnapshot } from '@agentdeck/contracts';

/** agent 要对终端做什么：read 读屏幕，send 打字。 */
export type AgentTerminalAccess = 'read' | 'send';

/** 判断要用的目标终端的情况。 */
export interface AgentTerminalTarget {
  /** 目标的当前状态；不知道时为 undefined（不挡）。 */
  status: Pick<StatusSnapshot, 'status'> | undefined;
}

export const WAITING_FOR_USER_MESSAGE = 'This terminal is waiting for the user. Use the inbox.';

/**
 * 不许时返回要报的错（code invalid-argument，2026-10-28 定：不加新的错误码），许可时返回 null。
 * - send：目标在等你（needs-approval、needs-reply）时不许打字。往停在批准提示上的终端打 “1” 加回车，等于替人按了批准，
 *   绕过收件箱、破坏性名单和 ApprovalRecord。回答要走收件箱。
 * - read：不挡。
 */
export function agentTerminalRefusal(access: AgentTerminalAccess, target: AgentTerminalTarget): AgentDeckError | null {
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
