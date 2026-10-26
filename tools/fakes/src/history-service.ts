// HistoryService 的假实现（MVP v3 · N11 · 左边栏历史会话）：用 set 预置会话列表，list 按最后活动倒序返回。

import type { AgentKind, AgentSessionId, HistoryService, SessionSummary } from '@agentdeck/contracts';

/** 一条历史会话，没给的字段按“终端里开的、用第一条消息当标题”填。 */
export function fakeSession(patch: Partial<SessionSummary> & { id: string; agent: AgentKind }): SessionSummary {
  return {
    cwd: null,
    branch: null,
    title: 'Untitled session',
    titleKind: 'prompt',
    firstPrompt: null,
    startedAt: '2026-10-26T08:00:00.000Z',
    updatedAt: '2026-10-26T09:00:00.000Z',
    source: 'terminal',
    model: null,
    file: `/fake/sessions/${patch.agent}/${patch.id}.jsonl`,
    ...patch,
    id: patch.id as AgentSessionId,
  };
}

export class FakeHistoryService implements HistoryService {
  private sessions: SessionSummary[] = [];
  /** list 被调了几次（测试看轮询）。 */
  calls = 0;

  async list(): Promise<SessionSummary[]> {
    this.calls += 1;
    return structuredClone([...this.sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)));
  }

  /** 换掉全部会话。 */
  set(sessions: SessionSummary[]): void {
    this.sessions = sessions;
  }
}
