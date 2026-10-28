// SessionRepository：AgentDeck 自己的 Session（M9 · SE1）。sessions 一行一条，agent 自己的会话 id 按先后放在 session_agent_ids。
// 父子、来历、名字存在这里；窗口和 Session 的对应只在白板上（TerminalWindowData.session）。

import type { Database } from 'better-sqlite3';
import type {
  AgentKind,
  AgentSessionId,
  AgentSessionReason,
  AgentSessionSegment,
  IsoTime,
  Session,
  SessionId,
  SessionListOptions,
  SessionOrigin,
  SessionState,
  TerminalId,
  WorkspaceId,
} from '@agentdeck/contracts';
import type { SessionRepository, SessionStateChange } from './types.ts';

interface SessionRow {
  id: string;
  agent: string;
  workspace_id: string | null;
  cwd: string;
  parent_id: string | null;
  origin: string;
  label: string | null;
  title: string | null;
  terminal_id: string | null;
  state: string;
  handed_off_to: string | null;
  handoff_note: string | null;
  created_at: string;
  updated_at: string;
}

interface SegmentRow {
  session_id: string;
  seq: number;
  agent_session_id: string;
  started_at: string;
  reason: string;
}

type Params = Record<string, string | number | null>;

/** 新的在前；同一时刻建的按插入先后（rowid）分。 */
const NEWEST_FIRST = 'ORDER BY created_at DESC, rowid DESC';
const OLDEST_FIRST = 'ORDER BY created_at, rowid';

export function createSessionRepository(db: Database): SessionRepository {
  const get = db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?');
  const all = db.prepare<[], SessionRow>(`SELECT * FROM sessions ${NEWEST_FIRST}`);
  const byParent = db.prepare<[string], SessionRow>(`SELECT * FROM sessions WHERE parent_id = ? ${OLDEST_FIRST}`);
  const byTerminal = db.prepare<[string], SessionRow>(
    'SELECT * FROM sessions WHERE terminal_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1',
  );
  const byAgentSession = db.prepare<[string, string], SessionRow>(`
    SELECT s.* FROM sessions s JOIN session_agent_ids a ON a.session_id = s.id
    WHERE s.agent = ? AND a.agent_session_id = ?
    ORDER BY s.updated_at DESC, a.seq DESC LIMIT 1
  `);
  const segments = db.prepare<[string], SegmentRow>('SELECT * FROM session_agent_ids WHERE session_id = ? ORDER BY seq');
  const nextSeq = db.prepare<[string], { n: number }>(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM session_agent_ids WHERE session_id = ?',
  );
  const insertSegment = db.prepare<Params>(`
    INSERT INTO session_agent_ids (session_id, seq, agent_session_id, started_at, reason)
    VALUES (@sessionId, @seq, @agentSessionId, @startedAt, @reason)
  `);
  const clearSegments = db.prepare<[string]>('DELETE FROM session_agent_ids WHERE session_id = ?');
  const upsert = db.prepare<Params>(`
    INSERT INTO sessions (id, agent, workspace_id, cwd, parent_id, origin, label, title, terminal_id, state, handed_off_to, handoff_note, created_at, updated_at)
    VALUES (@id, @agent, @workspaceId, @cwd, @parentId, @origin, @label, @title, @terminalId, @state, @handedOffTo, @handoffNote, @createdAt, @updatedAt)
    ON CONFLICT (id) DO UPDATE SET
      agent = excluded.agent,
      workspace_id = excluded.workspace_id,
      cwd = excluded.cwd,
      parent_id = excluded.parent_id,
      origin = excluded.origin,
      label = excluded.label,
      title = excluded.title,
      terminal_id = excluded.terminal_id,
      state = excluded.state,
      handed_off_to = excluded.handed_off_to,
      handoff_note = excluded.handoff_note,
      updated_at = excluded.updated_at
  `);
  const setState = db.prepare<Params>(
    'UPDATE sessions SET state = @state, terminal_id = @terminalId, handed_off_to = @handedOffTo, updated_at = @at WHERE id = @id',
  );
  const touch = db.prepare<[string, string]>('UPDATE sessions SET updated_at = ? WHERE id = ?');
  const remove = db.prepare<[string]>('DELETE FROM sessions WHERE id = ?');

  const load = (row: SessionRow | undefined): Session | null => (row ? toSession(row, segments.all(row.id)) : null);

  const put = db.transaction((s: Session) => {
    upsert.run({
      id: s.id,
      agent: s.agent,
      workspaceId: s.workspaceId,
      cwd: s.cwd,
      parentId: s.parentId,
      origin: JSON.stringify(s.origin),
      label: s.label,
      title: s.title,
      terminalId: s.terminalId,
      state: s.state,
      handedOffTo: s.handedOffTo,
      handoffNote: s.handoffNote,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
    clearSegments.run(s.id);
    s.agentSessions.forEach((seg, i) => insertSegment.run(segmentParams(s.id, i + 1, seg)));
  });

  const updateState = db.transaction((id: SessionId, change: SessionStateChange): Session | null => {
    const cur = load(get.get(id));
    if (!cur) return null;
    const state = change.state ?? cur.state;
    setState.run({
      id,
      state,
      terminalId: change.terminalId === undefined ? cur.terminalId : change.terminalId,
      // handed-off 以外的状态不留接班的那条
      handedOffTo: state === 'handed-off' ? (change.handedOffTo ?? cur.handedOffTo) : null,
      at: change.at ?? new Date().toISOString(),
    });
    return load(get.get(id));
  });

  const addSegment = db.transaction((id: SessionId, seg: AgentSessionSegment, at?: IsoTime): Session | null => {
    if (!get.get(id)) return null;
    insertSegment.run(segmentParams(id, nextSeq.get(id)!.n, seg));
    touch.run(at ?? new Date().toISOString(), id);
    return load(get.get(id));
  });

  return {
    list(opts: SessionListOptions = {}) {
      return all
        .all()
        .filter((r) => opts.workspaceId === undefined || r.workspace_id === opts.workspaceId)
        .filter((r) => opts.state === undefined || r.state === opts.state)
        .map((r) => toSession(r, segments.all(r.id)));
    },
    get: (id) => load(get.get(id)),
    listByParent: (parentId) => byParent.all(parentId).map((r) => toSession(r, segments.all(r.id))),
    findByAgentSession: (agent, agentSessionId) => load(byAgentSession.get(agent, agentSessionId)),
    findByTerminal: (terminalId) => load(byTerminal.get(terminalId)),
    put: (session) => put(session),
    updateState: (id, change) => updateState(id, change),
    addSegment: (id, segment, at) => addSegment(id, segment, at),
    remove: (id) => remove.run(id).changes > 0,
  };
}

function segmentParams(sessionId: string, seq: number, seg: AgentSessionSegment): Params {
  return { sessionId, seq, agentSessionId: seg.id, startedAt: seg.startedAt, reason: seg.reason };
}

function toSession(row: SessionRow, segs: SegmentRow[]): Session {
  return {
    id: row.id as SessionId,
    agent: row.agent as AgentKind,
    workspaceId: row.workspace_id as WorkspaceId | null,
    cwd: row.cwd,
    parentId: row.parent_id as SessionId | null,
    origin: JSON.parse(row.origin) as SessionOrigin,
    label: row.label,
    title: row.title,
    agentSessions: segs.map((s) => ({
      id: s.agent_session_id as AgentSessionId,
      startedAt: s.started_at,
      reason: s.reason as AgentSessionReason,
    })),
    terminalId: row.terminal_id as TerminalId | null,
    state: row.state as SessionState,
    handedOffTo: row.handed_off_to as SessionId | null,
    handoffNote: row.handoff_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
