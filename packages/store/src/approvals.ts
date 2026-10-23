import type { Database } from 'better-sqlite3';
import type { AgentKind, ApprovalRecord, RequestId, TerminalId, WorkspaceId } from '@agentdeck/contracts';
import type { ApprovalRepository } from './types.ts';

interface ApprovalRow {
  request_id: string;
  terminal_id: string;
  workspace_id: string | null;
  agent: string;
  kind: string;
  summary: string;
  command: string | null;
  destructive: number;
  requested_at: string;
  by: string;
  at: string;
}

type ApprovalParams = Record<string, string | number | null>;

export function createApprovalRepository(db: Database): ApprovalRepository {
  const insert = db.prepare<ApprovalParams>(`
    INSERT INTO approval_history (request_id, terminal_id, workspace_id, agent, kind, summary, command, destructive, requested_at, by, at)
    VALUES (@requestId, @terminalId, @workspaceId, @agent, @kind, @summary, @command, @destructive, @requestedAt, @by, @at)
  `);
  const history = db.prepare<[string, number], ApprovalRow>(
    'SELECT * FROM approval_history WHERE workspace_id = ? ORDER BY at DESC, seq DESC LIMIT ?',
  );

  return {
    add({ request: r, by, at }) {
      insert.run({
        requestId: r.id,
        terminalId: r.terminalId,
        workspaceId: r.workspaceId,
        agent: r.agent,
        kind: r.kind,
        summary: r.summary,
        command: r.command,
        destructive: r.destructive ? 1 : 0,
        requestedAt: r.at,
        by,
        at,
      });
    },
    history: (workspaceId, limit) => history.all(workspaceId, limit).map(toRecord),
  };
}

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    request: {
      id: row.request_id as RequestId,
      terminalId: row.terminal_id as TerminalId,
      workspaceId: row.workspace_id as WorkspaceId | null,
      agent: row.agent as AgentKind,
      kind: row.kind as ApprovalRecord['request']['kind'],
      summary: row.summary,
      command: row.command,
      destructive: row.destructive !== 0,
      at: row.requested_at,
    },
    by: row.by as ApprovalRecord['by'],
    at: row.at,
  };
}
