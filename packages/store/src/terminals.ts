import type { Database } from 'better-sqlite3';
import type {
  AgentKind,
  AgentSessionId,
  SessionId,
  TerminalId,
  TerminalStatus,
  WindowId,
  WorkspaceId,
} from '@agentdeck/contracts';
import type { TerminalRecord, TerminalRepository } from './types.ts';

interface TerminalRow {
  terminal_id: string;
  window_id: string | null;
  workspace_id: string | null;
  agent: string;
  cmd: string;
  args: string;
  cwd: string;
  agent_session_id: string | null;
  session_id: string | null;
  start_command: string | null;
  last_status: string;
  exit_code: number | null;
  updated_at: string;
}

type TerminalParams = Record<string, string | number | null>;

export function createTerminalRepository(db: Database): TerminalRepository {
  const list = db.prepare<[], TerminalRow>('SELECT * FROM terminals ORDER BY updated_at DESC, terminal_id');
  const byWorkspace = db.prepare<[string], TerminalRow>(
    'SELECT * FROM terminals WHERE workspace_id = ? ORDER BY updated_at DESC, terminal_id',
  );
  const get = db.prepare<[string], TerminalRow>('SELECT * FROM terminals WHERE terminal_id = ?');
  const byWindow = db.prepare<[string], TerminalRow>('SELECT * FROM terminals WHERE window_id = ?');
  const dropOtherInWindow = db.prepare<[string, string]>(
    'DELETE FROM terminals WHERE window_id = ? AND terminal_id <> ?',
  );
  const upsert = db.prepare<TerminalParams>(`
    INSERT INTO terminals (terminal_id, window_id, workspace_id, agent, cmd, args, cwd, agent_session_id, session_id, start_command, last_status, exit_code, updated_at)
    VALUES (@terminalId, @windowId, @workspaceId, @agent, @cmd, @args, @cwd, @agentSessionId, @session, @startCommand, @lastStatus, @exitCode, @updatedAt)
    ON CONFLICT (terminal_id) DO UPDATE SET
      window_id = excluded.window_id,
      workspace_id = excluded.workspace_id,
      agent = excluded.agent,
      cmd = excluded.cmd,
      args = excluded.args,
      cwd = excluded.cwd,
      agent_session_id = excluded.agent_session_id,
      session_id = excluded.session_id,
      start_command = excluded.start_command,
      last_status = excluded.last_status,
      exit_code = excluded.exit_code,
      updated_at = excluded.updated_at
  `);
  const put = db.transaction((r: TerminalRecord) => {
    if (r.windowId !== null) dropOtherInWindow.run(r.windowId, r.terminalId);
    upsert.run({
      terminalId: r.terminalId,
      windowId: r.windowId,
      workspaceId: r.workspaceId,
      agent: r.agent,
      cmd: r.cmd,
      args: JSON.stringify(r.args),
      cwd: r.cwd,
      agentSessionId: r.sessionId,
      session: r.session ?? null,
      startCommand: r.startCommand,
      lastStatus: r.lastStatus,
      exitCode: r.exitCode,
      updatedAt: r.updatedAt,
    });
  });
  const updateStatus = db.prepare<[string, number | null, string, string]>(
    'UPDATE terminals SET last_status = ?, exit_code = ?, updated_at = ? WHERE terminal_id = ?',
  );
  const updateSession = db.prepare<[string | null, string, string]>(
    'UPDATE terminals SET agent_session_id = ?, updated_at = ? WHERE terminal_id = ?',
  );
  const remove = db.prepare<[string]>('DELETE FROM terminals WHERE terminal_id = ?');
  const ids = db.prepare<[], { terminal_id: string }>('SELECT terminal_id FROM terminals');
  const prune = db.transaction((keep: readonly TerminalId[]) => {
    const live = new Set<string>(keep);
    let n = 0;
    for (const { terminal_id } of ids.all()) if (!live.has(terminal_id)) n += remove.run(terminal_id).changes;
    return n;
  });

  return {
    list: () => list.all().map(toRecord),
    listByWorkspace: (workspaceId) => byWorkspace.all(workspaceId).map(toRecord),
    get(terminalId) {
      const row = get.get(terminalId);
      return row ? toRecord(row) : null;
    },
    getByWindow(windowId) {
      const row = byWindow.get(windowId);
      return row ? toRecord(row) : null;
    },
    put: (record) => put(record),
    updateStatus: (terminalId, status, exitCode, at = new Date().toISOString()) =>
      updateStatus.run(status, exitCode, at, terminalId).changes > 0,
    updateSession: (terminalId, sessionId, at = new Date().toISOString()) =>
      updateSession.run(sessionId, at, terminalId).changes > 0,
    remove: (terminalId) => remove.run(terminalId).changes > 0,
    prune: (keep) => prune(keep),
  };
}

function toRecord(row: TerminalRow): TerminalRecord {
  return {
    terminalId: row.terminal_id as TerminalId,
    windowId: row.window_id as WindowId | null,
    workspaceId: row.workspace_id as WorkspaceId | null,
    agent: row.agent as AgentKind,
    cmd: row.cmd,
    args: JSON.parse(row.args) as string[],
    cwd: row.cwd,
    sessionId: row.agent_session_id as AgentSessionId | null,
    session: row.session_id as SessionId | null,
    startCommand: row.start_command,
    lastStatus: row.last_status as TerminalStatus,
    exitCode: row.exit_code,
    updatedAt: row.updated_at,
  };
}
