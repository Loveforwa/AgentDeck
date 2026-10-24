// Auto-approve 的开关（PL1）：开在工作区框上，或开在单个终端上。
// 规则（docs/plugins.md）：贴在框上 = 框里所有终端，包括之后新开的；单个终端上的设置优先；
// 框上关掉 / 打开会清掉框里终端单独的设置（框上关掉，框里的都关）。

import type { AutoApproveState, IsoTime, TerminalId, WorkspaceId } from '@agentdeck/contracts';

export class AutoApproveScopes {
  private readonly workspaces = new Map<WorkspaceId, IsoTime>();
  private readonly terminals = new Map<TerminalId, { on: boolean; since: IsoTime }>();

  /** 框的开关。inWorkspace 是框里现在的终端，它们单独的设置清掉。返回状态有没有变。 */
  setWorkspace(workspaceId: WorkspaceId, on: boolean, inWorkspace: readonly TerminalId[], now: IsoTime): boolean {
    let changed = false;
    for (const id of inWorkspace) changed = this.terminals.delete(id) || changed;
    if (on && !this.workspaces.has(workspaceId)) {
      this.workspaces.set(workspaceId, now);
      changed = true;
    } else if (!on) {
      changed = this.workspaces.delete(workspaceId) || changed;
    }
    return changed;
  }

  /**
   * 单个终端的开关。on 为 null 去掉单独设置。和框的状态一样时也不留单独设置（框开着时单独开 = 跟着框）。
   * workspaceId 是终端所在的框，不知道时为 null（按散放处理）。返回状态有没有变。
   */
  setTerminal(terminalId: TerminalId, on: boolean | null, workspaceId: WorkspaceId | null, now: IsoTime): boolean {
    const prev = this.terminals.get(terminalId);
    const frameOn = workspaceId !== null && this.workspaces.has(workspaceId);
    if (on === null || on === frameOn) {
      return this.terminals.delete(terminalId);
    }
    if (prev?.on === on) return false;
    this.terminals.set(terminalId, { on, since: now });
    return true;
  }

  /** 终端没了（窗口关掉、进程结束后被 forget）时去掉它单独的设置。 */
  forgetTerminal(terminalId: TerminalId): boolean {
    return this.terminals.delete(terminalId);
  }

  /** 和 contracts 的 isAutoApproveOn 同一条规则（测试核对两边一致）。 */
  isOn(terminalId: TerminalId, workspaceId: WorkspaceId | null): boolean {
    const own = this.terminals.get(terminalId);
    if (own) return own.on;
    return workspaceId !== null && this.workspaces.has(workspaceId);
  }

  /** 从什么时候开着（框和单独设置里晚的那个，给书签的 “since 14:02”）。没开着时为 null。 */
  since(terminalId: TerminalId, workspaceId: WorkspaceId | null): IsoTime | null {
    const own = this.terminals.get(terminalId);
    if (own) return own.on ? own.since : null;
    return workspaceId !== null ? (this.workspaces.get(workspaceId) ?? null) : null;
  }

  state(): AutoApproveState {
    return {
      workspaces: [...this.workspaces].map(([workspaceId, since]) => ({ workspaceId, since })),
      terminals: [...this.terminals].map(([terminalId, t]) => ({ terminalId, on: t.on, since: t.since })),
    };
  }
}
