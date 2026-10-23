import { join } from 'node:path';
import type { BoardState } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NEVER_SAVED, emptyBoard, openStore } from '../src/index.ts';
import type { Store } from '../src/index.ts';
import { board, tempDir } from './fixtures.ts';

let store: Store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => store.close());

describe('BoardStore', () => {
  it('returns a blank board on an empty database', async () => {
    expect(await store.board.load()).toEqual({
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      frames: [],
      windows: [],
      panel: { open: true, width: 320 },
      savedAt: NEVER_SAVED,
    });
  });

  it('round-trips the whole state', async () => {
    const state = board();
    await store.board.save(state);
    expect(await store.board.load()).toEqual(state);
  });

  it('replaces the previous state instead of merging', async () => {
    await store.board.save(board());
    const next = board({ frames: [], windows: [], savedAt: '2026-10-02T10:00:00.000Z' });
    await store.board.save(next);
    expect(await store.board.load()).toEqual(next);
  });

  it('keeps the previous state when a save fails halfway', async () => {
    const before = board();
    await store.board.save(before);
    // savedAt 为 null 会在插入时违反 NOT NULL，此时旧行已经删掉，必须回滚。
    const bad = { ...board({ frames: [] }), savedAt: null } as unknown as BoardState;
    await expect(store.board.save(bad)).rejects.toThrow(/NOT NULL/);
    expect(await store.board.load()).toEqual(before);
  });

  it('rejects an unknown board version', async () => {
    const bad = { ...emptyBoard(), version: 2 } as unknown as BoardState;
    await expect(store.board.save(bad)).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('survives closing and reopening the file', async () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'agentdeck.db');
      const first = openStore(file);
      await first.board.save(board());
      first.close();
      const second = openStore(file);
      expect(await second.board.load()).toEqual(board());
      second.close();
    } finally {
      tmp.cleanup();
    }
  });
});
