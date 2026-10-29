// DocService：读写、baseHash 冲突、临时文件 + rename、只读、盯文件发 doc.changed、“谁改的”、快照、列 .md。

import { chmodSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocEvent, TerminalId } from '@agentdeck/contracts';
import { LocalDocService, createDocServices, sha1, toolUsePaths } from '../src/index.ts';
import { put, sleep, stubGit, tempDir, until } from './helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function service(root: string, extra: Partial<ConstructorParameters<typeof LocalDocService>[0]> = {}) {
  const events: DocEvent[] = [];
  const docs = new LocalDocService({ git: stubGit(root).git, emit: (e) => events.push(e), debounceMs: 30, ...extra });
  cleanups.push(() => docs.close());
  return { docs, events };
}

const claude = { kind: 'agent' as const, terminalId: 't1' as TerminalId, agent: 'claude' as const, label: 'claude' };

describe('read and write', () => {
  it('reads with a sha1 hash and the repo, and refuses a write on a stale baseHash', async () => {
    const root = tempDir(cleanups);
    const doc = put(root, 'docs/a.md', 'one\n');
    const { docs } = service(root);
    const f = await docs.read(doc);
    expect(f).toMatchObject({ path: doc, text: 'one\n', hash: sha1('one\n'), repo: root, readOnly: false });
    writeFileSync(doc, 'agent\n');
    const res = await docs.write(doc, 'mine\n', { baseHash: f.hash });
    expect(res).toMatchObject({ ok: false, conflict: { theirs: { text: 'agent\n', hash: sha1('agent\n') } } });
    expect(readFileSync(doc, 'utf8')).toBe('agent\n');
    expect(await docs.write(doc, 'mine\n', { baseHash: sha1('agent\n') })).toEqual({ ok: true, hash: sha1('mine\n') });
    expect(readdirSync(join(root, 'docs'))).toEqual(['a.md']); // 临时文件不留下
    await expect(docs.read(join(root, 'nope.md'))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('keeps the file mode, writes through a symlink and creates a new file from the empty hash', async () => {
    const root = tempDir(cleanups);
    const real = put(root, 'docs/real.md', 'x\n');
    chmodSync(real, 0o640);
    symlinkSync(real, join(root, 'docs/link.md'));
    const { docs } = service(root);
    await docs.write(join(root, 'docs/link.md'), 'y\n', { baseHash: sha1('x\n') });
    expect(readFileSync(real, 'utf8')).toBe('y\n');
    expect(readdirSync(join(root, 'docs')).sort()).toEqual(['link.md', 'real.md']);
    const { statSync, lstatSync } = await import('node:fs');
    expect(statSync(real).mode & 0o777).toBe(0o640);
    expect(lstatSync(join(root, 'docs/link.md')).isSymbolicLink()).toBe(true);
    expect((await docs.write(join(root, 'docs/new.md'), '# New\n', { baseHash: sha1('') })).ok).toBe(true);
  });

  it('opens files in the data folder read-only', async () => {
    const root = tempDir(cleanups);
    const report = put(root, 'data/crew/report.md', '# Report\n');
    const { docs } = service(root, { readOnlyRoots: [join(root, 'data')] });
    expect((await docs.read(report)).readOnly).toBe(true);
    await expect(docs.write(report, 'x', { baseHash: sha1('# Report\n') })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('watch, who changed it, snapshots', () => {
  it('sends doc.changed for disk changes, attributes agent writes within 2 s and its own saves to me', async () => {
    const root = tempDir(cleanups);
    const doc = put(root, 'docs/a.md', 'v1\n');
    const { docs, events } = service(root);
    await docs.watch(doc);
    await docs.watch(doc); // 第二次没有副作用

    // 钩子先到，磁盘变化后到
    docs.noteAgentWrite(doc, claude);
    await sleep(10);
    writeFileSync(doc, 'v2\n');
    expect(await until(() => events.find((e) => e.type === 'doc.changed' && e.hash === sha1('v2\n')))).toMatchObject({ by: claude });

    // 2 秒内又变了一次：还算 claude 的（它可能连着写了两次）
    writeFileSync(doc, 'v3\n');
    expect(await until(() => events.find((e) => e.type === 'doc.changed' && e.hash === sha1('v3\n')))).toMatchObject({ by: claude });
    await sleep(2200); // claude 的钩子过期
    // 磁盘变化先到，钩子后到：补上 by，再发一次
    writeFileSync(doc, 'v4\n');
    const plain = await until(() => events.find((e) => e.type === 'doc.changed' && e.hash === sha1('v4\n')));
    expect(plain).toMatchObject({ by: null });
    docs.noteAgentWrite(doc, { ...claude, terminalId: 't2' as TerminalId });
    expect(await until(() => events.find((e) => e.type === 'doc.changed' && e.hash === sha1('v4\n') && e.by !== null))).toMatchObject({
      by: { terminalId: 't2' },
    });

    // 自己保存
    const res = await docs.write(doc, 'v5\n', { baseHash: sha1('v4\n') });
    expect(res.ok).toBe(true);
    expect(events.filter((e) => e.type === 'doc.changed' && e.hash === sha1('v5\n'))).toEqual([
      { type: 'doc.changed', path: doc, hash: sha1('v5\n'), by: { kind: 'me' } },
    ]);
    await sleep(100); // 盯文件那边看到同样的内容，不再发
    expect(events.filter((e) => e.type === 'doc.changed' && e.hash === sha1('v5\n'))).toHaveLength(1);

    const snaps = await docs.snapshots(doc);
    expect(snaps.map((s) => s.hash)).toEqual(['v1\n', 'v2\n', 'v3\n', 'v4\n', 'v5\n'].map(sha1));
    expect(snaps.map((s) => s.by?.kind ?? null)).toEqual([null, 'agent', 'agent', 'agent', 'me']);
    expect(await docs.snapshot(doc, sha1('v3\n'))).toBe('v3\n');
    expect(await docs.snapshot(doc, 'nope')).toBeNull();

    await docs.unwatch(doc);
    const n = events.length;
    writeFileSync(doc, 'v6\n');
    await sleep(150);
    expect(events.length).toBe(n);
  });

  it('keeps at most 50 snapshots', async () => {
    const root = tempDir(cleanups);
    const doc = put(root, 'a.md', '0');
    const { docs } = service(root);
    let hash = (await docs.read(doc)).hash;
    for (let i = 1; i <= 60; i += 1) {
      const r = await docs.write(doc, String(i), { baseHash: hash });
      if (r.ok) hash = r.hash;
    }
    const snaps = await docs.snapshots(doc);
    expect(snaps).toHaveLength(50);
    expect(await docs.snapshot(doc, sha1('60'))).toBe('60');
    expect(await docs.snapshot(doc, sha1('5'))).toBeNull();
  });
});

describe('list', () => {
  it('lists .md files with their titles, from git when it can and by walking the folder otherwise', async () => {
    const root = tempDir(cleanups);
    put(root, 'README.md', '# Read me\n\ntext\n');
    put(root, 'docs/plan.md', 'no heading\n');
    put(root, 'docs/notes.txt', 'x\n');
    put(root, 'node_modules/pkg/README.md', '# dep\n');
    put(root, '.hidden/x.md', '# hidden\n');
    const walked = service(root, { git: { repoRoot: async () => null } }).docs;
    expect(await walked.list(root)).toEqual([
      { path: join(root, 'README.md'), title: 'Read me' },
      { path: join(root, 'docs/plan.md'), title: null },
    ]);
    const fromGit = service(root, { git: { repoRoot: async () => root, listFiles: async () => ['README.md', 'docs/plan.md', 'docs/notes.txt'] } }).docs;
    expect((await fromGit.list(join(root, 'docs'))).map((d) => d.path)).toEqual([join(root, 'docs/plan.md')]);
  });
});

describe('toolUsePaths', () => {
  it('reads file paths from PostToolUse payloads', () => {
    expect(toolUsePaths('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '/r/docs/a.md' } }, null)).toEqual(['/r/docs/a.md']);
    expect(toolUsePaths('PostToolUse', { cwd: '/r', tool_input: { file_path: 'docs/a.md' } }, '/other')).toEqual(['/r/docs/a.md']);
    expect(toolUsePaths('PostToolUse', { tool_input: { notebook_path: 'n.ipynb' } }, '/r')).toEqual(['/r/n.ipynb']);
    const patch = '*** Begin Patch\n*** Update File: docs/a.md\n@@\n-x\n+y\n*** Add File: docs/b.md\n+z\n*** End Patch';
    expect(toolUsePaths('PostToolUse', { tool_input: { command: ['apply_patch', patch] } }, '/r')).toEqual(['/r/docs/a.md', '/r/docs/b.md']);
    expect(toolUsePaths('PreToolUse', { tool_input: { file_path: '/r/a.md' } }, null)).toEqual([]);
    expect(toolUsePaths('PostToolUse', { tool_input: { file_path: 'rel.md' } }, null)).toEqual([]);
  });

  it('is wired through createDocServices().noteToolUse', async () => {
    const root = tempDir(cleanups);
    const doc = put(root, 'a.md', 'x\n');
    const events: DocEvent[] = [];
    const s = createDocServices({ git: stubGit(root).git, emit: (e) => events.push(e) });
    cleanups.push(() => s.close());
    await s.api.docs.watch(doc);
    s.noteToolUse({ terminalId: 't9' as TerminalId, agent: 'codex', hookName: 'PostToolUse', payload: { tool_input: { file_path: 'a.md' } }, cwd: root });
    await sleep(20);
    writeFileSync(doc, 'y\n');
    expect(await until(() => events.find((e) => e.type === 'doc.changed'))).toMatchObject({
      by: { kind: 'agent', terminalId: 't9', agent: 'codex', label: 'codex' },
    });
    expect(Object.keys(s.api.docs).sort()).toEqual(['list', 'read', 'snapshot', 'snapshots', 'unwatch', 'watch', 'write']);
    expect(Object.keys(s.api.anchors).sort()).toEqual(['fixLines', 'markVerified', 'peek', 'resolve']);
  });
});
