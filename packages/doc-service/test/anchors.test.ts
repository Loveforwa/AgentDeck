// CodeAnchorService 对着假 git（helpers.ts 的 stubGit）：基准的优先级、路径换算、缓存、fixLines / markVerified、
// 什么时候重算。真 git 上的场景（TC-99、TC-100、drift、耗时）在 apps/desktop/test/doc-anchors.test.ts。

import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocEvent, GitEvent, RepoStatus } from '@agentdeck/contracts';
import { parseCodeRefs } from '@agentdeck/contracts';
import { LocalCodeAnchorService, LocalDocService, memoryAnchorStore, refKey } from '../src/index.ts';
import { put, sleep, stubGit, tempDir, until } from './helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const C1 = 'c'.repeat(40);
const C2 = 'd'.repeat(40);
const ZERO = '0'.repeat(40);
const code = (n: number, tag = 'v') => `${Array.from({ length: n }, (_, i) => `const ${tag}${i + 1} = ${i + 1};`).join('\n')}\n`;

function setup(root: string, git: ReturnType<typeof stubGit>['git']) {
  const events: DocEvent[] = [];
  const store = memoryAnchorStore();
  const docs = new LocalDocService({ git, debounceMs: 20, emit: (e) => events.push(e) });
  const anchors = new LocalCodeAnchorService({ git, docs, store, emit: (e) => events.push(e), targetDebounceMs: 40 });
  cleanups.push(() => {
    anchors.close();
    docs.close();
  });
  return { docs, anchors, store, events };
}

function status(repo: string, head: string): GitEvent {
  return { type: 'git.status', status: { repo, head } as RepoStatus };
}

describe('baselines', () => {
  it('takes pinned > verified > blame > worktree', async () => {
    const root = tempDir(cleanups);
    put(root, 'src/x.ts', `// new first line\n${code(10)}`);
    const doc = put(root, 'docs/a.md', 'a src/x.ts:3\nb src/x.ts@v1:3\nc src/x.ts:3\nd src/x.ts:4\n');
    const { git } = stubGit(root, {
      versions: { [C1]: { 'src/x.ts': code(10) }, v1: { 'src/x.ts': code(10) } },
      blame: { 'docs/a.md': [C1, C1, ZERO, C1] },
    });
    const { anchors } = setup(root, git);
    const { refs } = await anchors.resolve(doc);
    expect(refs.map((r) => [r.baseline.source, r.state, r.now?.start])).toEqual([
      ['blame', 'moved', 4],
      ['pinned', 'ok', 3],
      ['worktree', 'ok', 3], // 这一行文档没提交：以现在为准
      ['blame', 'moved', 5],
    ]);
    expect(refs[1]?.ref.text).toBe('const v3 = 3;');

    await anchors.markVerified(doc, [refs[3]!.ref]);
    const again = await anchors.resolve(doc);
    expect(again.refs[3]).toMatchObject({ baseline: { source: 'verified', rev: null }, state: 'moved', now: { start: 5 } });
  });

  it('says outside for docs outside a repository, paths outside the worktree, (new) and external refs', async () => {
    const root = tempDir(cleanups);
    const other = tempDir(cleanups);
    put(root, 'src/x.ts', code(5));
    put(root, 'docs/sub/y.ts', code(5));
    const doc = put(root, 'docs/a.md', `${other}/z.ts:1, ./sub/y.ts:2, ../src/x.ts:3, src/plan.ts (new)\n`);
    const { git } = stubGit(root);
    const { anchors } = setup(root, git);
    const { refs } = await anchors.resolve(doc);
    expect(refs.map((r) => [r.state, r.now?.path ?? null])).toEqual([
      ['outside', null],
      ['ok', 'docs/sub/y.ts'],
      ['ok', 'src/x.ts'],
      ['outside', null],
    ]);
    const loose = put(other, 'notes.md', 'see src/x.ts:1\n');
    expect((await anchors.resolve(loose)).refs[0]).toMatchObject({ state: 'outside', detail: 'This document isn’t in a Git repository' });
  });

  it('ranks short-path candidates by the words of the sentence', async () => {
    const root = tempDir(cleanups);
    put(root, 'a/index.ts', 'export function render() {}\n');
    put(root, 'b/index.ts', 'export function openTerminal() {}\n');
    const doc = put(root, 'a.md', 'The terminal opens in index.ts:1 through openTerminal.\n');
    const { git } = stubGit(root, { files: ['a.md', 'a/index.ts', 'b/index.ts'] });
    const { anchors } = setup(root, git);
    const [r] = (await anchors.resolve(doc)).refs;
    expect(r).toMatchObject({ state: 'ambiguous', now: null, candidates: ['b/index.ts', 'a/index.ts'] });
  });
});

describe('cache, fixLines, markVerified', () => {
  it('does not ask git again for refs whose file did not change', async () => {
    const root = tempDir(cleanups);
    put(root, 'src/x.ts', `\n${code(10)}`);
    const doc = put(root, 'a.md', 'src/x.ts:3 and src/x.ts:5\n');
    const { git, calls } = stubGit(root, { versions: { [C1]: { 'src/x.ts': code(10) } }, blame: { 'a.md': [C1] } });
    const { anchors, store } = setup(root, git);
    await anchors.resolve(doc);
    const first = calls.length;
    await anchors.resolve(doc);
    expect(calls.length).toBe(first); // blame 也按文档内容缓存
    expect(store.cache(doc)).toHaveLength(2);
    put(root, 'src/x.ts', `\n\n${code(10)}`);
    expect((await anchors.resolve(doc)).refs.map((r) => r.now?.start)).toEqual([5, 7]);
    expect(calls.length).toBeGreaterThan(first);
  });

  it('only rewrites moved line numbers and carries the checked record along', async () => {
    const root = tempDir(cleanups);
    put(root, 'src/x.ts', `\n\n${code(20)}`);
    const text = 'moved src/x.ts:3-4, pinned src/x.ts@v1:3, same `src/x.ts:1`, claude @src/x.ts#L10-L12 x\n';
    const doc = put(root, 'a.md', text);
    const { git } = stubGit(root, { versions: { [C1]: { 'src/x.ts': `\n\n${code(20)}` }, [C2]: { 'src/x.ts': code(20) }, v1: { 'src/x.ts': code(20) } } });
    const { anchors, store } = setup(root, git);
    // 这一行文档写在 C2（代码顶上还没插两行的时候）
    const refs = parseCodeRefs(text);
    git.blameLines = async () => [{ line: 1, commit: C2 }];
    await anchors.markVerified(doc, [refs[0]!]);
    expect(store.verified(doc).map((v) => [v.refKey, v.start, v.end])).toEqual([[refKey(refs[0]!), 5, 6]]);
    expect(await anchors.fixLines(doc, refs)).toBe(3);
    expect((await import('node:fs')).readFileSync(doc, 'utf8')).toBe(
      'moved src/x.ts:5-6, pinned src/x.ts@v1:3, same `src/x.ts:3`, claude @src/x.ts#L12-L14 x\n',
    );
    expect(store.verified(doc).map((v) => v.refKey)).toEqual(['src/x.ts|5|6||']);
    expect(await anchors.fixLines(doc, refs)).toBe(0); // 原文已经变了，旧的 refs 对不上，不改
  });
});

describe('when it re-checks', () => {
  it('checks on open, after a referenced file is saved, after a commit, and stops after unwatch', async () => {
    const root = tempDir(cleanups);
    const x = put(root, 'src/x.ts', code(10));
    const doc = put(root, 'a.md', 'src/x.ts:3\n');
    const { git, calls } = stubGit(root, { versions: { [C1]: { 'src/x.ts': code(10) } }, blame: { 'a.md': [C1] } });
    const { docs, anchors, events } = setup(root, git);
    const anchorEvents = () => events.filter((e) => e.type === 'doc.anchors');
    await docs.watch(doc);
    await until(() => (anchorEvents().length === 1 ? true : undefined));
    expect(anchorEvents()[0]).toMatchObject({ path: doc, summary: { total: 1, counts: { ok: 1 } } });

    writeFileSync(x, `\n${code(10)}`);
    await until(() => (anchorEvents().length === 2 ? true : undefined));
    expect(anchorEvents()[1]).toMatchObject({ summary: { counts: { moved: 1 } } });

    // 提交（HEAD 变了）：blame 重新问
    anchors.noteGitEvent(status(root, 'h1'));
    anchors.noteGitEvent(status(root, 'h1'));
    const blames = calls.filter((c) => c.startsWith('blame')).length;
    anchors.noteGitEvent(status(root, 'h2'));
    await until(() => (anchorEvents().length === 3 ? true : undefined));
    expect(calls.filter((c) => c.startsWith('blame')).length).toBe(blames + 1);

    // 文档自己变了
    writeFileSync(doc, 'src/x.ts:3 and src/x.ts:99\n');
    await until(() => (anchorEvents().length === 4 ? true : undefined));
    expect(anchorEvents()[3]).toMatchObject({ summary: { total: 2 } });

    await docs.unwatch(doc);
    writeFileSync(x, code(10));
    await sleep(150);
    expect(anchorEvents()).toHaveLength(4);
  });
});

describe('peek', () => {
  it('shows the code around the ref and a diff when it changed', async () => {
    const root = tempDir(cleanups);
    const now = code(10).replace('const v5 = 5;', 'const v5 = 50;');
    put(root, 'src/x.ts', now);
    const doc = put(root, 'a.md', 'src/x.ts:5\n');
    const { git } = stubGit(root, { versions: { [C1]: { 'src/x.ts': code(10) } }, blame: { 'a.md': [C1] } });
    const { anchors } = setup(root, git);
    const [ref] = parseCodeRefs('src/x.ts:5\n');
    const p = await anchors.peek(doc, ref!);
    expect(p.lines.map((l) => l.n)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(p.lines[3]?.text).toBe('const v5 = 50;');
    expect(p.diff).toBe('--- a/src/x.ts\n+++ b/src/x.ts\n@@ -5,1 +5,1 @@\n-const v5 = 5;\n+const v5 = 50;\n');
  });
});

