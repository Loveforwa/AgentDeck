// 测试用：临时目录、一个按内存表回答的 git（showFile 按预置的版本，lineMap 用本包自己的行级 diff 算到工作区）。

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AbsPath, LineMapHunk } from '@agentdeck/contracts';
import type { AnchorGit } from '../src/index.ts';
import { diffLines, splitLines } from '../src/lines.ts';

export function tempDir(cleanups: (() => void)[]): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-docs-')));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

export function put(root: string, rel: string, text: string): string {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

/** 假 git：repo 是 root；versions[rev][path] 是那个版本的文件；blame[path] 是文档每行的提交。 */
export function stubGit(root: string, opts: { versions?: Record<string, Record<string, string>>; blame?: Record<string, string[]>; files?: string[] } = {}) {
  const calls: string[] = [];
  const git: AnchorGit = {
    repoRoot: async (dir: AbsPath) => (dir.startsWith(root) ? root : null),
    blameLines: async (_repo, path) => {
      calls.push(`blame ${path}`);
      const b = opts.blame?.[path];
      if (!b) return splitLines(readFileSync(join(root, path), 'utf8')).map((_, i) => ({ line: i + 1, commit: '0'.repeat(40) }));
      return b.map((commit, i) => ({ line: i + 1, commit }));
    },
    showFile: async (_repo, rev, path) => {
      calls.push(`show ${rev} ${path}`);
      return opts.versions?.[rev]?.[path] ?? null;
    },
    lineMap: async (_repo, path, from): Promise<LineMapHunk[]> => {
      calls.push(`map ${from} ${path}`);
      const old = opts.versions?.[from]?.[path];
      let now = '';
      try {
        now = readFileSync(join(root, path), 'utf8');
      } catch {
        // 删掉了
      }
      return old === undefined ? [] : diffLines(splitLines(old), splitLines(now));
    },
    listFiles: async () => opts.files ?? [],
  };
  return { git, calls };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(15);
  }
}
