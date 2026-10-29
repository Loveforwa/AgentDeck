// DC2：doc-service 接上真的 git-service 和 store（组装后的样子），在临时仓库里跑 TC-97、TC-98、TC-99、TC-100、TC-106 的后台部分，
// 外加 100 处引用一次核对的耗时（本机 < 300ms，CI 上不跑）。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocEvent, TerminalId } from '@agentdeck/contracts';
import { parseCodeRefs } from '@agentdeck/contracts';
import { classify, createDocServices, interesting, splitLines, type DocServices } from '@agentdeck/doc-service';
import { createTempRepo, type TempRepo } from '@agentdeck/fakes/temp-repo';
import { createGitService } from '@agentdeck/git-service';
import { openStore, type Store } from '@agentdeck/store';

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'AgentDeck Test',
  GIT_AUTHOR_EMAIL: 'test@agentdeck.invalid',
  GIT_COMMITTER_NAME: 'AgentDeck Test',
  GIT_COMMITTER_EMAIL: 'test@agentdeck.invalid',
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup(): { docs: DocServices; store: Store; events: DocEvent[] } {
  const store = openStore(':memory:');
  const events: DocEvent[] = [];
  const git = createGitService({ env: ENV, moveToTrash: async () => {} });
  const docs = createDocServices({ git, store: store.docAnchors, emit: (e) => events.push(e) });
  cleanups.push(() => {
    docs.close();
    store.close();
  });
  return { docs, store, events };
}

async function repo(files: Record<string, string>): Promise<TempRepo> {
  const r = await createTempRepo({ commits: [{ subject: 'Code', files }], branches: [] });
  cleanups.push(() => r.cleanup());
  return r;
}

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `const ${tag}${i + 1} = ${i + 1};`);
const text = (ls: string[]) => `${ls.join('\n')}\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

/** src/x.ts 第 10–12 行是 foo。 */
function xTs(): string {
  const x = lines(20, 'x');
  x.splice(9, 3, 'export function foo() {', '  return 42;', '}');
  return text(x);
}

const DOC = [
  '# Design',
  '',
  'The answer comes from src/x.ts:10-12 `foo`, and the fifth value is set in src/y.ts:5.',
  'The old helper lives in src/z.ts:3.',
  'Both entry points start at index.ts:1.',
  '',
].join('\n');

describe('code anchors on a real repository (TC-99, TC-106)', () => {
  it('shows moved, changed, gone and ambiguous refs, fixes line numbers and marks a ref as checked', async () => {
    const r = await repo({
      'src/x.ts': xTs(),
      'src/y.ts': text(lines(8, 'y')),
      'src/z.ts': text(lines(5, 'z')),
      'src/a/index.ts': 'export const a = 1;\n',
      'src/b/index.ts': 'export const b = 2;\n',
    });
    r.commit('Write the doc', { 'docs/a.md': DOC });
    // 1. x.ts 顶上插 3 行，不改 foo（不提交）；2. 改 y.ts 第 5 行（不提交）；3. git rm z.ts 并提交
    r.writeFile('src/x.ts', `\n\n\n${xTs()}`);
    const y = lines(8, 'y');
    y[4] = 'const y5 = 500;';
    r.writeFile('src/y.ts', text(y));
    r.git('rm', '-q', 'src/z.ts');
    r.git('commit', '-q', '-m', 'Remove z');
    const statusBefore = r.git('status', '--porcelain', '--untracked-files=all');

    const { docs, store, events } = setup();
    const doc = join(r.path, 'docs/a.md');
    const { refs, summary } = await docs.anchors.resolve(doc);
    const by = (p: string) => refs.find((x) => x.ref.path === p)!;
    expect(by('src/x.ts')).toMatchObject({ state: 'moved', now: { path: 'src/x.ts', start: 13, end: 15 }, baseline: { source: 'blame' } });
    expect(by('src/x.ts').ref.text).toBe('export function foo() {');
    expect(by('src/y.ts')).toMatchObject({ state: 'changed', now: { path: 'src/y.ts', start: 5, end: 5 } });
    expect(by('src/z.ts')).toMatchObject({ state: 'gone', detail: 'src/z.ts was deleted' });
    expect(by('index.ts')).toMatchObject({ state: 'ambiguous' });
    expect(by('index.ts').candidates).toHaveLength(2);
    expect(summary).toMatchObject({ total: 4, counts: { ok: 0, moved: 1, changed: 1, gone: 1, ambiguous: 1, outside: 0 } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'doc.anchors', path: doc }));
    // 结果缓存在库里（不是仓库里）
    expect(store.docAnchors.cache(doc).length).toBeGreaterThanOrEqual(2);

    // 悬停：现在的代码前后各 3 行；changed 时附上 diff
    const peekY = await docs.anchors.peek(doc, by('src/y.ts').ref);
    expect(peekY.lines.map((l) => l.n)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(peekY.diff).toContain('-const y5 = 5;');
    expect(peekY.diff).toContain('+const y5 = 500;');

    // 5. Update line numbers：只有 10-12 变成 13-15
    const all = parseCodeRefs(readFileSync(doc, 'utf8'));
    expect(await docs.anchors.fixLines(doc, all)).toBe(1);
    expect(readFileSync(doc, 'utf8')).toBe(DOC.replace('src/x.ts:10-12', 'src/x.ts:13-15'));
    expect(r.git('diff', '--numstat', '--', 'docs/a.md')).toBe('1\t1\tdocs/a.md');

    // 6. Mark as checked：y.ts 那处以现在为新基准，不再标
    const yRef = parseCodeRefs(readFileSync(doc, 'utf8')).find((x) => x.path === 'src/y.ts')!;
    await docs.anchors.markVerified(doc, [yRef]);
    const after = await docs.anchors.resolve(doc);
    expect(after.refs.find((x) => x.ref.path === 'src/y.ts')).toMatchObject({ state: 'ok', baseline: { source: 'verified', rev: null } });
    expect(after.refs.find((x) => x.ref.path === 'src/x.ts')).toMatchObject({ state: 'ok', now: { start: 13, end: 15 } });
    expect(store.docAnchors.verified(doc)).toHaveLength(1);

    // 核对过以后代码又改了：以核对时为基准，又是 changed
    y[4] = 'const y5 = 5000;';
    r.writeFile('src/y.ts', text(y));
    expect((await docs.anchors.resolve(doc)).refs.find((x) => x.ref.path === 'src/y.ts')?.state).toBe('changed');

    // TC-106：仓库里除了 a.md 本身没有多出任何文件
    const statusAfter = r.git('status', '--porcelain', '--untracked-files=all');
    expect(statusAfter.split('\n').filter((l) => !statusBefore.includes(l))).toEqual([' M docs/a.md']);
  });

  it('follows a renamed file and pinned refs stay on their commit', async () => {
    const r = await repo({ 'src/old.ts': xTs() });
    const c1 = r.git('rev-parse', 'HEAD');
    r.commit('Doc', { 'docs/a.md': `See src/old.ts:10-12 \`foo\` and src/old.ts@${c1.slice(0, 7)}:11.\n` });
    r.git('mv', 'src/old.ts', 'src/new.ts');
    r.writeFile('src/new.ts', `// moved\n${xTs()}`);
    r.git('add', '-A');
    const { docs } = setup();
    const { refs } = await docs.anchors.resolve(join(r.path, 'docs/a.md'));
    expect(refs[0]).toMatchObject({ state: 'gone', detail: 'Renamed to src/new.ts', now: { path: 'src/new.ts', start: 11, end: 13 } });
    expect(refs[1]).toMatchObject({ state: 'ok', baseline: { source: 'pinned', rev: c1.slice(0, 7) }, now: { path: 'src/old.ts', start: 11 } });
    expect(refs[1]?.ref.text).toBe('  return 42;');
  });

  it('checks a doc that was never committed against the working tree, and new / external refs not at all', async () => {
    const r = await repo({ 'src/x.ts': xTs() });
    r.writeFile(
      'notes.md',
      'Draft: src/x.ts:10 `foo` and src/x.ts:99, src/x.ts:1 `nope`, apps/plan.ts (new), openai/codex main (2026-10-26) codex-rs/core/src/lib.rs:5\n',
    );
    const { docs } = setup();
    const { refs } = await docs.anchors.resolve(join(r.path, 'notes.md'));
    expect(refs.map((x) => [x.state, x.baseline.source])).toEqual([
      ['ok', 'worktree'],
      ['gone', 'worktree'],
      ['gone', 'worktree'],
      ['outside', 'worktree'],
      ['outside', 'worktree'],
    ]);
  });
});

describe('two worktrees (TC-100)', () => {
  it('checks the same doc against each worktree’s own code', async () => {
    const r = await repo({ 'src/x.ts': xTs() });
    r.commit('Doc', { 'docs/a.md': 'The answer is in src/x.ts:11.\n' });
    const feat = r.addWorktree('feat/x', { create: true });
    const x = xTs().split('\n');
    x[10] = '  return 43;';
    writeFileSync(join(feat, 'src/x.ts'), x.join('\n'));
    const { docs, store } = setup();
    const main = await docs.anchors.resolve(join(r.path, 'docs/a.md'));
    const branch = await docs.anchors.resolve(join(feat, 'docs/a.md'));
    expect(main.refs[0]?.state).toBe('ok');
    expect(branch.refs[0]?.state).toBe('changed');
    // 两个窗口的缓存分开
    expect(store.docAnchors.cache(join(r.path, 'docs/a.md'))).toHaveLength(1);
    expect(store.docAnchors.cache(join(feat, 'docs/a.md'))).toHaveLength(1);
  });
});

describe('doc windows: watching, who changed it, saving (TC-97, TC-98)', () => {
  it('sends doc.changed with the agent from its PostToolUse hook, or nobody for a plain edit', async () => {
    const r = await repo({ 'src/x.ts': xTs() });
    r.commit('Doc', { 'docs/a.md': '# A\n\nfirst\n' });
    const doc = join(r.path, 'docs/a.md');
    const { docs, events } = setup();
    await docs.docs.watch(doc);
    // claude 写文件：钩子带着路径（相对路径按终端的目录算）
    writeFileSync(doc, '# A\n\nsecond, by claude\n');
    docs.noteToolUse({
      terminalId: 't1' as TerminalId,
      agent: 'claude',
      hookName: 'PostToolUse',
      payload: { tool_name: 'Edit', tool_input: { file_path: 'docs/a.md' } },
      cwd: r.path,
    });
    const byClaude = await until(() =>
      events.find((e) => e.type === 'doc.changed' && e.by?.kind === 'agent' && e.by.terminalId === 't1'),
    );
    expect(byClaude).toMatchObject({ path: doc, by: { kind: 'agent', agent: 'claude', label: 'claude' } });

    await sleep(2300); // 超过 2 秒，不再算 claude 的
    const n = events.length;
    writeFileSync(doc, '# A\n\nsecond, by claude\nx\n');
    const plain = await until(() => events.slice(n).find((e) => e.type === 'doc.changed'));
    expect(plain).toMatchObject({ type: 'doc.changed', by: null });
    const snaps = await docs.docs.snapshots(doc);
    expect(snaps.map((s) => s.by?.kind ?? null)).toEqual([null, 'agent', null]);
    expect(await docs.docs.snapshot(doc, snaps[0]!.hash)).toBe('# A\n\nfirst\n');
    // 打开窗口时核对了一次引用（doc.anchors）
    expect(events.some((e) => e.type === 'doc.anchors' && e.path === doc)).toBe(true);
  });

  it('refuses a save on a stale baseHash, writes through a temp file and leaves nothing behind', async () => {
    const r = await repo({ 'README.md': '# x\n' });
    r.commit('Doc', { 'docs/a.md': 'mine\n' });
    const doc = join(r.path, 'docs/a.md');
    const { docs } = setup();
    const read = await docs.docs.read(doc);
    expect(read).toMatchObject({ repo: r.path, readOnly: false });
    writeFileSync(doc, 'theirs\n');
    const conflict = await docs.docs.write(doc, 'mine, edited\n', { baseHash: read.hash });
    expect(conflict).toMatchObject({ ok: false, conflict: { theirs: { text: 'theirs\n' } } });
    expect(readFileSync(doc, 'utf8')).toBe('theirs\n');
    const inode = statSync(doc).ino;
    if (conflict.ok) throw new Error('expected a conflict');
    const ok = await docs.docs.write(doc, 'merged\n', { baseHash: conflict.conflict.theirs.hash });
    expect(ok.ok).toBe(true);
    expect(readFileSync(doc, 'utf8')).toBe('merged\n');
    expect(statSync(doc).ino).not.toBe(inode); // rename 换了文件
    expect(readdirSync(join(r.path, 'docs'))).toEqual(['a.md']);
    expect((await docs.docs.list(r.path)).map((d) => d.path)).toEqual([join(r.path, 'README.md'), doc]);
  });
});

describe('performance', () => {
  // 本机才跑：CI 机器忙的时候不稳
  it.skipIf(Boolean(process.env['CI']))('checks a document with 100 refs in under 300 ms', async () => {
    const files: Record<string, string> = {};
    for (let f = 0; f < 10; f += 1) files[`src/mod${f}/file${f}.ts`] = text(lines(400, `m${f}_`));
    const r = await repo(files);
    // 文档分 5 次写（每次 20 处），中间代码在变：blame 出 5 个不同的基准，每个基准 × 10 个文件都要问 git
    const body: string[] = ['# Big doc', ''];
    for (let round = 0; round < 5; round += 1) {
      for (let i = round * 20; i < (round + 1) * 20; i += 1) {
        const f = i % 10;
        const line = 10 + i * 3;
        body.push(`Step ${i}: src/mod${f}/file${f}.ts:${line}-${line + 2} sets m${f}_${line}.`);
      }
      r.commit(`Doc part ${round + 1}`, { 'docs/big.md': `${body.join('\n')}\n` });
      const code: Record<string, string> = {};
      for (let f = 0; f < 10; f += 1) code[`src/mod${f}/file${f}.ts`] = text([...Array.from({ length: round + 1 }, (_, k) => `// round ${k}`), ...lines(400, `m${f}_`)]);
      r.commit(`Code round ${round + 1}`, code);
    }
    // 代码在文档之后又改了几处：挪行号要真的算
    for (let f = 0; f < 10; f += 1) {
      const ls = lines(400, `m${f}_`);
      ls.splice(50, 0, '// inserted', '// inserted');
      ls[200] = 'const changed = true;';
      r.writeFile(`src/mod${f}/file${f}.ts`, text(ls));
    }
    const doc = join(r.path, 'docs/big.md');
    // 一次冷启动（新的库、新的服务）的耗时取 3 次里最快的：整套测试并行跑时机器很忙
    let coldMs = Infinity;
    let warmMs = Infinity;
    let cold: Awaited<ReturnType<DocServices['anchors']['resolve']>> | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { docs } = setup();
      const t0 = performance.now();
      cold = await docs.anchors.resolve(doc);
      coldMs = Math.min(coldMs, performance.now() - t0);
      const t1 = performance.now();
      await docs.anchors.resolve(doc);
      warmMs = Math.min(warmMs, performance.now() - t1);
    }
    if (!cold) throw new Error('not resolved');
    console.log(`[DC2] 100 refs: first check ${coldMs.toFixed(0)} ms, cached ${warmMs.toFixed(0)} ms`);
    expect(cold.summary.total).toBe(100);
    expect(cold.summary.counts.moved + cold.summary.counts.changed + cold.summary.counts.ok).toBe(100);
    expect(cold.summary.counts.changed).toBeGreaterThan(0);
    expect(coldMs).toBeLessThan(300);
    expect(warmMs).toBeLessThan(coldMs);
  });
});

// 本仓库上的 drift 对照（第 11 点 p11/measure/drift.py 的同样场景）：要 python3 和足够长的历史，AGENTDECK_DRIFT=1 时才跑。
describe.skipIf(process.env['AGENTDECK_DRIFT'] !== '1')('line drift on this repository (point 11)', () => {
  const FILES = [
    'apps/desktop/src/main/index.ts',
    'packages/contracts/src/board.ts',
    'packages/contracts/src/agent.ts',
    'packages/ui/widgets/terminal/src/TerminalWindow.tsx',
    'packages/agent-adapters/src/adapters/claude.ts',
    'packages/agent-adapters/src/agent-service.ts',
    'packages/mcp-server/src/tools.ts',
    'packages/ui/canvas/src/react/SettingsDialog.tsx',
    'packages/agent-adapters/src/skills/library.ts',
    'packages/ui/widgets/browser/src/BrowserWindow.tsx',
  ];
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const head = process.env['AGENTDECK_DRIFT_HEAD'] ?? 'HEAD';

  it.each([10, 30, 100])('HEAD~%i: every line lands where difflib puts it', async (back) => {
    const git = createGitService({ env: ENV, moveToTrash: async () => {} });
    const rev = `${head}~${back}`;
    let total = 0;
    let same = 0;
    let found = 0;
    let agree = 0;
    for (const f of FILES) {
      const oldText = await git.showFile(root, rev, f);
      const newText = await git.showFile(root, head, f);
      if (oldText === null || newText === null) continue;
      const base = splitLines(oldText);
      const now = splitLines(newText);
      const hunks = await git.lineMap(root, f, rev, head);
      const py = difflibMap(oldText, newText);
      base.forEach((line, i) => {
        if (!interesting(line)) return;
        total += 1;
        const c = classify(base, now, hunks, i + 1, i + 1);
        const ours = c.kind === 'same' ? c.start : null;
        if (ours === i + 1) same += 1;
        if (ours !== null) found += 1;
        // difflib 说找到了 → 我们也说内容没变；difflib 没找到 → 我们也说改了或没了
        if ((py[i] !== undefined) === (ours !== null)) agree += 1;
      });
    }
    console.log(
      `[DC2 drift] ${rev}: lines ${total}; still right ${((100 * same) / total).toFixed(0)}%; found ${((100 * found) / total).toFixed(0)}%; agrees with difflib ${((100 * agree) / total).toFixed(1)}%`,
    );
    expect(agree / total).toBeGreaterThan(0.98);
  });
});

/** drift.py 的做法：difflib.SequenceMatcher 的 matching blocks，旧行号（0 起）→ 新行号。 */
function difflibMap(oldText: string, newText: string): Record<number, number> {
  const dir = join(process.env['TMPDIR'] ?? '/tmp', `agentdeck-drift-${process.pid}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a'), oldText);
  writeFileSync(join(dir, 'b'), newText);
  const py = [
    'import difflib, json, sys',
    "a = open(sys.argv[1]).read().split('\\n'); b = open(sys.argv[2]).read().split('\\n')",
    'm = {}',
    'for i, j, n in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():',
    '    for k in range(n): m[i + k] = j + k',
    'print(json.dumps(m))',
  ].join('\n');
  const out = execFileSync('python3', ['-I', '-c', py, join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out) as Record<number, number>;
}
