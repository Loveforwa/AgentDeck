// 核对缓存和“核对过”的记录存在哪：应用里是 packages/store 的 docAnchors（迁移 3，apps/desktop 注入）。
// 本包是服务包，不能 import store（.dependency-cruiser.cjs 的 service-to-service），所以这里照着它的形状写一份接口；
// apps/desktop 传 store.docAnchors 时由 TypeScript 核对两边一致。不给时用内存里的（测试、没有库的时候）。

import type { AbsPath, IsoTime } from '@agentdeck/contracts';

export interface AnchorCacheRow {
  refKey: string;
  /** pinned:<rev> / verified:<blob> / blame:<commit> / worktree */
  baseline: string;
  /** 工作区里被引用文件的 sha1。 */
  targetHash: string;
  /** JSON。 */
  result: string;
  checkedAt: IsoTime;
}

export interface AnchorVerified {
  docPath: AbsPath;
  refKey: string;
  path: string;
  start: number;
  end: number;
  /** git 的 blob id。 */
  blob: string;
  linesHash: string;
  verifiedAt: IsoTime;
}

export interface AnchorStore {
  cache(docPath: AbsPath): AnchorCacheRow[];
  replaceCache(docPath: AbsPath, rows: AnchorCacheRow[]): void;
  verified(docPath: AbsPath): AnchorVerified[];
  putVerified(records: AnchorVerified[], blobs: { blob: string; text: string }[]): void;
  moveVerified(docPath: AbsPath, from: string, to: string): void;
  blob(blob: string): string | null;
}

export function memoryAnchorStore(): AnchorStore {
  const cache = new Map<AbsPath, AnchorCacheRow[]>();
  const verified = new Map<AbsPath, Map<string, AnchorVerified>>();
  const blobs = new Map<string, string>();
  const dropUnused = () => {
    const used = new Set([...verified.values()].flatMap((m) => [...m.values()].map((v) => v.blob)));
    for (const b of [...blobs.keys()]) if (!used.has(b)) blobs.delete(b);
  };
  return {
    cache: (docPath) => (cache.get(docPath) ?? []).map((r) => ({ ...r })),
    replaceCache: (docPath, rows) => void cache.set(docPath, rows.map((r) => ({ ...r }))),
    verified: (docPath) => [...(verified.get(docPath)?.values() ?? [])].map((v) => ({ ...v })),
    putVerified: (records, list) => {
      for (const b of list) if (!blobs.has(b.blob)) blobs.set(b.blob, b.text);
      for (const v of records) {
        const m = verified.get(v.docPath) ?? new Map<string, AnchorVerified>();
        m.set(v.refKey, { ...v });
        verified.set(v.docPath, m);
      }
      dropUnused();
    },
    moveVerified: (docPath, from, to) => {
      const m = verified.get(docPath);
      const v = m?.get(from);
      if (!m || !v || from === to) return;
      m.delete(from);
      m.set(to, { ...v, refKey: to });
    },
    blob: (b) => blobs.get(b) ?? null,
  };
}
