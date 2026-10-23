// BoardStore 的 SQLite 实现：board 表只有一行，存整份 BoardState 的 JSON。

import type { Database } from 'better-sqlite3';
import { AgentDeckError } from '@agentdeck/contracts';
import type { BoardState, BoardStore } from '@agentdeck/contracts';

/** 从来没保存过时 savedAt 用的时间。 */
export const NEVER_SAVED = new Date(0).toISOString();

export function emptyBoard(): BoardState {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    frames: [],
    windows: [],
    panel: { open: true, width: 320 },
    savedAt: NEVER_SAVED,
  };
}

export function createBoardStore(db: Database): BoardStore {
  const select = db.prepare<[], { state: string }>('SELECT state FROM board WHERE id = 1');
  const clear = db.prepare('DELETE FROM board');
  const insert = db.prepare<{ state: string; savedAt: string }>(
    'INSERT INTO board (id, state, saved_at) VALUES (1, @state, @savedAt)',
  );
  // 整份替换：先删再插，任何一步失败都回到原来那份。
  const replace = db.transaction((state: BoardState) => {
    clear.run();
    insert.run({ state: JSON.stringify(state), savedAt: state.savedAt });
  });

  return {
    async load() {
      const row = select.get();
      return row ? parseBoard(row.state) : emptyBoard();
    },
    async save(state) {
      if (state.version !== 1) {
        throw new AgentDeckError({
          code: 'invalid-argument',
          message: 'Unsupported board version.',
          detail: `version ${String(state.version)}`,
        });
      }
      replace(state);
    },
  };
}

function parseBoard(json: string): BoardState {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    throw new AgentDeckError({ code: 'internal', message: 'Saved board is corrupted.', detail: String(e) });
  }
  if (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== 1) {
    throw new AgentDeckError({
      code: 'internal',
      message: 'Saved board has an unknown format.',
      detail: json.slice(0, 200),
    });
  }
  return value as BoardState;
}
