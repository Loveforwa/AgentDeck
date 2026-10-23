// BoardStore 的假实现：整份白板存在内存里。

import type { BoardState, BoardStore } from '@agentdeck/contracts';
import { clone, nowIso } from './util.ts';

export function emptyBoard(): BoardState {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    frames: [],
    windows: [],
    panel: { open: true, width: 320 },
    savedAt: nowIso(),
  };
}

export class FakeBoardStore implements BoardStore {
  /** save 被调用的次数，测防抖用。 */
  saves = 0;
  private state: BoardState | null;

  constructor(initial: BoardState | null = null) {
    this.state = initial ? clone(initial) : null;
  }

  async load(): Promise<BoardState> {
    return clone(this.state ?? emptyBoard());
  }

  async save(state: BoardState): Promise<void> {
    this.state = clone(state);
    this.saves += 1;
  }

  /** 最后保存的白板；还没保存过为 null。 */
  current(): BoardState | null {
    return this.state ? clone(this.state) : null;
  }
}
