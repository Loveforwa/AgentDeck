// DocAnchorRepository：文档里代码引用的核对缓存和“核对过”的记录（M15 · DC2，迁移 3）。
// 用的人是 doc-service 的 CodeAnchorService（由 apps/desktop 注入，doc-service 不 import 本包），所以行的形状写在 types.ts 里。

import type { Database } from 'better-sqlite3';
import type { AbsPath } from '@agentdeck/contracts';
import type { DocAnchorCacheRow, DocAnchorRepository, DocAnchorVerified } from './types.ts';

interface CacheRow {
  ref_key: string;
  baseline: string;
  target_hash: string;
  result: string;
  checked_at: string;
}

interface VerifiedRow {
  doc_path: string;
  ref_key: string;
  path: string;
  start_line: number;
  end_line: number;
  blob: string;
  lines_hash: string;
  verified_at: string;
}

export function createDocAnchorRepository(db: Database): DocAnchorRepository {
  const cacheOf = db.prepare<[string], CacheRow>('SELECT * FROM doc_anchor_cache WHERE doc_path = ?');
  const clearCache = db.prepare<[string]>('DELETE FROM doc_anchor_cache WHERE doc_path = ?');
  const insertCache = db.prepare(`
    INSERT OR REPLACE INTO doc_anchor_cache (doc_path, ref_key, baseline, target_hash, result, checked_at)
    VALUES (@docPath, @refKey, @baseline, @targetHash, @result, @checkedAt)
  `);
  const verifiedOf = db.prepare<[string], VerifiedRow>('SELECT * FROM doc_anchor_verified WHERE doc_path = ?');
  const putBlob = db.prepare<[string, string]>('INSERT OR IGNORE INTO doc_anchor_blobs (blob, text) VALUES (?, ?)');
  const getBlob = db.prepare<[string], { text: string }>('SELECT text FROM doc_anchor_blobs WHERE blob = ?');
  const upsertVerified = db.prepare(`
    INSERT INTO doc_anchor_verified (doc_path, ref_key, path, start_line, end_line, blob, lines_hash, verified_at)
    VALUES (@docPath, @refKey, @path, @start, @end, @blob, @linesHash, @verifiedAt)
    ON CONFLICT (doc_path, ref_key) DO UPDATE SET
      path = excluded.path, start_line = excluded.start_line, end_line = excluded.end_line,
      blob = excluded.blob, lines_hash = excluded.lines_hash, verified_at = excluded.verified_at
  `);
  const removeVerified = db.prepare<[string, string]>('DELETE FROM doc_anchor_verified WHERE doc_path = ? AND ref_key = ?');
  const renameKey = db.prepare<[string, string, string]>('UPDATE doc_anchor_verified SET ref_key = ? WHERE doc_path = ? AND ref_key = ?');
  // 没有记录再用到的全文删掉
  const dropUnused = db.prepare('DELETE FROM doc_anchor_blobs WHERE blob NOT IN (SELECT blob FROM doc_anchor_verified)');

  return {
    cache: (docPath) =>
      cacheOf.all(docPath).map((r) => ({
        refKey: r.ref_key,
        baseline: r.baseline,
        targetHash: r.target_hash,
        result: r.result,
        checkedAt: r.checked_at,
      })),
    replaceCache: db.transaction((docPath: AbsPath, rows: DocAnchorCacheRow[]) => {
      clearCache.run(docPath);
      for (const r of rows) insertCache.run({ docPath, ...r });
    }),
    verified: (docPath) => verifiedOf.all(docPath).map(toVerified),
    putVerified: db.transaction((records: DocAnchorVerified[], blobs: { blob: string; text: string }[]) => {
      for (const b of blobs) putBlob.run(b.blob, b.text);
      for (const v of records) upsertVerified.run({ ...v });
      dropUnused.run();
    }),
    moveVerified: db.transaction((docPath: AbsPath, from: string, to: string) => {
      if (from === to) return;
      removeVerified.run(docPath, to);
      renameKey.run(to, docPath, from);
    }),
    blob: (blob) => getBlob.get(blob)?.text ?? null,
  };
}

function toVerified(r: VerifiedRow): DocAnchorVerified {
  return {
    docPath: r.doc_path,
    refKey: r.ref_key,
    path: r.path,
    start: r.start_line,
    end: r.end_line,
    blob: r.blob,
    linesHash: r.lines_hash,
    verifiedAt: r.verified_at,
  };
}
