// ApprovalService 占位（Approve all、Auto-approve 是 P1 的 X3）。现在每个方法都明确地说“不支持”，
// 界面据此不显示 Approve all…；P1 时按 contracts 的注释实现：发 approveOnceKeys，2 秒内状态没离开 needs-approval 就算 couldnt-approve。

import { AgentDeckError } from '@agentdeck/contracts';
import type { ApprovalRecord, ApprovalService, ApproveResult, RequestId, WorkspaceId } from '@agentdeck/contracts';

export class ApprovalServicePlaceholder implements ApprovalService {
  async approve(ids: RequestId[]): Promise<ApproveResult[]> {
    return ids.map((id) => ({ id, ok: false, reason: 'unsupported' }));
  }

  async setAutoApprove(_workspaceId: WorkspaceId, _on: boolean): Promise<void> {
    throw new AgentDeckError({ code: 'unsupported', message: 'Auto-approve is not available yet' });
  }

  async history(_workspaceId: WorkspaceId, _limit: number): Promise<ApprovalRecord[]> {
    return [];
  }
}
