// DC0：假 DocService（内存文件、baseHash 冲突、doc.changed）和假 CodeAnchorService（固定表、fixLines）。
import { describe, expect, it } from 'vitest';
import type { TerminalId } from '@agentdeck/contracts';
import { createFakeServices } from '../src/api.ts';

const DOC = '/Users/you/code/app/docs/design.md';
const TEXT = '# Design\n\nThe window is in `src/Window.tsx:10-20` `onLink` and src/a.ts:3. Plan: src/new.ts (new)\n';

describe('FakeDocService', () => {
  it('writes with a base hash and reports conflicts after an agent edit', async () => {
    const { fakes, bus } = createFakeServices();
    fakes.docs.setFile(DOC, TEXT, { repo: '/Users/you/code/app' });
    await fakes.docs.watch(DOC);
    const first = await fakes.docs.read(DOC);
    fakes.docs.externalEdit(DOC, `${TEXT}More.\n`, { kind: 'agent', terminalId: 't1' as TerminalId, agent: 'claude', label: 'claude' });
    const res = await fakes.docs.write(DOC, 'mine', { baseHash: first.hash });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflict.theirs.text).toContain('More.');
    const again = await fakes.docs.read(DOC);
    expect(await fakes.docs.write(DOC, 'mine', { baseHash: again.hash })).toMatchObject({ ok: true });
    expect(bus.eventsOf('doc.changed').map((e) => e.by?.kind)).toEqual(['agent', 'me']);
    expect((await fakes.docs.snapshots(DOC)).length).toBe(3);
    expect(await fakes.docs.list('/Users/you/code/app')).toEqual([{ path: DOC, title: null }]);
  });
});

describe('FakeCodeAnchorService', () => {
  it('answers from its table and fixes moved line numbers through DocService', async () => {
    const { fakes } = createFakeServices();
    fakes.docs.setFile(DOC, TEXT);
    fakes.anchors.setState(DOC, 'src/Window.tsx:10-20', { state: 'moved', now: { path: 'src/Window.tsx', start: 18, end: 28 } });
    fakes.anchors.setState(DOC, 'src/a.ts:3', { state: 'changed' });
    const { refs, summary } = await fakes.anchors.resolve(DOC);
    expect(refs.map((r) => r.state)).toEqual(['moved', 'changed', 'outside']);
    expect(refs[0]?.ref.symbol).toBe('onLink');
    expect(summary.counts).toMatchObject({ moved: 1, changed: 1, outside: 1, ok: 0 });

    expect(await fakes.anchors.fixLines(DOC, refs.map((r) => r.ref))).toBe(1);
    expect(fakes.docs.textOf(DOC)).toContain('`src/Window.tsx:18-28` `onLink`');
    await fakes.anchors.markVerified(DOC, [refs[1]!.ref]);
    const after = await fakes.anchors.resolve(DOC);
    expect(after.refs.find((r) => r.ref.path === 'src/a.ts')).toMatchObject({ state: 'ok', baseline: { source: 'verified' } });
  });

  it('serves blame, files and line maps from the fake git presets', async () => {
    const { fakes } = createFakeServices();
    const repo = '/Users/you/code/app';
    fakes.git.addRepo({ path: repo, commits: ['Initial commit'] });
    fakes.git.setBlame('docs/design.md', ['aaa', 'bbb']);
    fakes.git.setFileAt('HEAD', 'src/a.ts', 'one\ntwo\n');
    fakes.git.setLineMap('src/a.ts', 'HEAD', 'worktree', [{ oldStart: 2, oldLines: 0, newStart: 3, newLines: 8 }]);
    expect(await fakes.git.blameLines(repo, 'docs/design.md')).toEqual([{ line: 1, commit: 'aaa' }, { line: 2, commit: 'bbb' }]);
    expect(await fakes.git.showFile(repo, 'HEAD', 'src/a.ts')).toBe('one\ntwo\n');
    expect(await fakes.git.showFile(repo, 'HEAD', 'nope.ts')).toBeNull();
    expect(await fakes.git.lineMap(repo, 'src/a.ts', 'HEAD', 'worktree')).toHaveLength(1);
    await expect(fakes.git.blameLines(repo, 'missing.md')).rejects.toMatchObject({ code: 'not-found' });
  });
});
