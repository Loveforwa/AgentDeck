// DocAnchorRepository（DC2，迁移 3）：核对缓存整篇替换、核对记录往返、改 key、没人用的全文清掉。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../src/index.ts';

let store: Store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => store.close());

const DOC = '/repo/docs/a.md';

describe('doc anchors', () => {
  it('replaces the whole cache of one document', () => {
    const row = { refKey: 'src/x.ts|10|12|foo|', baseline: 'blame:abc', targetHash: 'h1', result: '{"state":"ok"}', checkedAt: '2026-10-28T00:00:00Z' };
    store.docAnchors.replaceCache(DOC, [row, { ...row, refKey: 'src/y.ts|5|||' }]);
    store.docAnchors.replaceCache('/repo/docs/b.md', [row]);
    expect(store.docAnchors.cache(DOC)).toHaveLength(2);
    store.docAnchors.replaceCache(DOC, [{ ...row, targetHash: 'h2' }]);
    expect(store.docAnchors.cache(DOC)).toEqual([{ ...row, targetHash: 'h2' }]);
    expect(store.docAnchors.cache('/repo/docs/b.md')).toEqual([row]);
  });

  it('keeps verified records with their file text, moves keys and drops unused text', () => {
    const v = {
      docPath: DOC,
      refKey: 'src/y.ts|5|||',
      path: 'src/y.ts',
      start: 5,
      end: 5,
      blob: 'b1',
      linesHash: 'l1',
      verifiedAt: '2026-10-28T00:00:00Z',
    };
    store.docAnchors.putVerified([v], [{ blob: 'b1', text: 'one\ntwo\n' }]);
    expect(store.docAnchors.verified(DOC)).toEqual([v]);
    expect(store.docAnchors.blob('b1')).toBe('one\ntwo\n');

    store.docAnchors.moveVerified(DOC, v.refKey, 'src/y.ts|8|||');
    expect(store.docAnchors.verified(DOC).map((r) => r.refKey)).toEqual(['src/y.ts|8|||']);

    // 同一处再核对一次：换成新的全文，旧的没人用了就删掉
    store.docAnchors.putVerified([{ ...v, refKey: 'src/y.ts|8|||', blob: 'b2' }], [{ blob: 'b2', text: 'new\n' }]);
    expect(store.docAnchors.blob('b1')).toBeNull();
    expect(store.docAnchors.blob('b2')).toBe('new\n');
    expect(store.docAnchors.verified('/other.md')).toEqual([]);
  });
});
