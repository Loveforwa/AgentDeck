// CodeAnchorService 的真实实现（M15 · DC2）：文档里的 path:line 在代码变了以后还对不对得上。
// 设计见设计画布“文档”页 D1 第 2–3 节和 DR-94：
//   1. 定基准：写死的 @版本（pinned）> 上次核对通过时记下的（verified）> git blame 文档这一行所在的提交（blame）> 工作区现在（worktree）
//   2. 挪行号：基准 → 工作区的 git diff -U0（verified 的基准不一定在 git 里，用自己的行级 diff）
//   3. 对内容和符号：碰到 hunk 的在新文件里找原来那几行；符号第一期在新范围 ±20 行里按名字找
//   4. 六种状态，结果按（文档、引用、基准、工作区里那个文件的哈希）缓存在库里
// 重算时机：打开（DocService.watch）、doc.changed、被引用文件存盘（去抖 2 秒）、git 提交和切分支（noteGitEvent）。

import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { AgentDeckError, parseCodeRefs } from '@agentdeck/contracts';
import type {
  AbsPath,
  AnchorState,
  AnchorSummary,
  CodeAnchorService,
  CodeRef,
  DocEvent,
  GitEvent,
  GitService,
  LineMapHunk,
  ResolvedRef,
} from '@agentdeck/contracts';
import type { DocGit, LocalDocService } from './doc-service.ts';
import { gitBlobId, sha1 } from './hash.ts';
import { checkSymbol, classify, diffLines, findSymbol, mapLine, oldLength, splitLines, touches, type Classified } from './lines.ts';
import type { AnchorStore, AnchorVerified } from './store.ts';
import { memoryAnchorStore } from './store.ts';
import { DirWatcher } from './watch.ts';

/**
 * 核对要用的 git：contracts 的 GitService 的一部分。renamedPath（contracts 0.1.22，可选）是 from → to 之间 path 被改名成了什么，
 * 没有时改名的文件只能报 gone、不提示新路径。
 */
export type AnchorGit = DocGit & Pick<GitService, 'blameLines' | 'showFile' | 'lineMap' | 'renamedPath'>;

export interface CodeAnchorServiceOptions {
  git: AnchorGit;
  docs: LocalDocService;
  /** 缓存和核对记录。应用里是 packages/store 的 docAnchors（apps/desktop 注入）；不给时只在内存里。 */
  store?: AnchorStore;
  emit?: (event: DocEvent) => void;
  /** 被引用文件存盘以后等多久重算，默认 2000ms。 */
  targetDebounceMs?: number;
  watcher?: DirWatcher;
  now?: () => Date;
}

const ZERO = /^0+$/;
const STATES: readonly AnchorState[] = ['ok', 'moved', 'changed', 'gone', 'ambiguous', 'outside'];
/** 同时跑几条 git。 */
const CONCURRENCY = 12;
/** 一篇文档最多盯几个被引用的文件。 */
const MAX_TARGETS = 64;

/** 缓存里存的一处结果（不含 ref 本身）。 */
interface Cached {
  state: AnchorState;
  now?: { path: string; start: number; end: number } | null;
  detail?: string;
  candidates?: string[];
  text?: string;
  baseline: ResolvedRef['baseline'];
}

/** 一次 resolve 里共用的东西（同一个文件、同一个基准只问 git 一次）。 */
interface Ctx {
  docPath: AbsPath;
  /** 文档真实路径（算相对路径用）。 */
  docReal: string;
  docLines: string[];
  repo: string | null;
  docRel: string | null;
  verified: Map<string, AnchorVerified>;
  cache: Map<string, Cached>;
  rows: Map<string, { refKey: string; baseline: string; targetHash: string; result: Cached }>;
  memo: Map<string, Promise<unknown>>;
}

/** 内部结果：带上基准里那几行（peek 的 diff 用）。 */
interface Computed {
  r: Cached;
  base?: string[];
  baseStart?: number;
}

/** 一处引用在库里的 key：路径、起止行、符号、钉住的版本。 */
export function refKey(ref: Pick<CodeRef, 'path' | 'start' | 'end' | 'symbol' | 'rev'>): string {
  return [ref.path, ref.start ?? '', ref.end ?? '', ref.symbol ?? '', ref.rev ?? ''].join('|');
}

export class LocalCodeAnchorService implements CodeAnchorService {
  private readonly store: AnchorStore;
  private readonly watcher: DirWatcher;
  private readonly ownWatcher: boolean;
  private readonly targetDebounceMs: number;
  private readonly now: () => Date;
  /** 文档的 blame（按文档路径 + 内容哈希）；git 状态变了（提交、切分支）就清掉。 */
  private readonly blames = new Map<string, Promise<string[] | null>>();
  /** 开着窗口的文档：盯着它引用的文件，到时候重算。 */
  private readonly tracked = new Map<
    AbsPath,
    { repo: string | null; timer: ReturnType<typeof setTimeout> | null; running: boolean; again: boolean; targets: Map<string, () => void> }
  >();
  private readonly heads = new Map<string, string | null>();
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: CodeAnchorServiceOptions) {
    this.store = opts.store ?? memoryAnchorStore();
    this.watcher = opts.watcher ?? new DirWatcher();
    this.ownWatcher = opts.watcher === undefined;
    this.targetDebounceMs = opts.targetDebounceMs ?? 2000;
    this.now = opts.now ?? (() => new Date());
    this.unsubscribe = opts.docs.subscribe((c) => {
      if (c.type === 'watch') this.track(c.path);
      else if (c.type === 'unwatch') this.untrack(c.path);
      else if (this.tracked.has(c.path)) this.schedule(c.path, 50);
    });
  }

  // ---- CodeAnchorService ----

  async resolve(docPath: AbsPath, refs?: CodeRef[]): Promise<{ refs: ResolvedRef[]; summary: AnchorSummary }> {
    const ctx = await this.context(docPath);
    const list = refs ?? parseCodeRefs(ctx.docLines.join('\n'));
    const computed = await limit(list, CONCURRENCY, (ref) => this.resolveOne(ctx, ref));
    const resolved = list.map((ref, i) => toResolved(ref, computed[i]!.r));
    const counts = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<AnchorState, number>;
    for (const r of resolved) counts[r.state] += 1;
    const summary: AnchorSummary = { total: resolved.length, counts, checkedAt: this.now().toISOString() };

    // 缓存：整篇核对时换成这一次用到的；只核对几处时并进去
    const rows = new Map(refs === undefined ? [] : this.store.cache(docPath).map((r) => [cacheId(r.refKey, r.baseline, r.targetHash), r]));
    for (const [id, r] of ctx.rows)
      rows.set(id, { refKey: r.refKey, baseline: r.baseline, targetHash: r.targetHash, result: JSON.stringify(r.result), checkedAt: summary.checkedAt });
    if (refs === undefined || ctx.rows.size > 0) this.store.replaceCache(docPath, [...rows.values()]);

    if (refs === undefined) {
      this.emit({ type: 'doc.anchors', path: docPath, summary: { ...summary, counts: { ...counts } } });
      const t = this.tracked.get(docPath);
      if (t) {
        t.repo = ctx.repo;
        this.watchTargets(docPath, ctx.repo, resolved);
      }
    }
    return { refs: resolved, summary };
  }

  async peek(docPath: AbsPath, ref: CodeRef): Promise<{ lines: { n: number; text: string }[]; diff: string | null }> {
    const ctx = await this.context(docPath);
    const c = await this.compute(ctx, ref);
    const r = c.r;
    const rel = ctx.repo ? relPath(ctx, ref.path) : null;
    let text: string | null = null;
    let at: { start: number; end: number } | null = null;
    if (ref.rev !== undefined && rel !== null) {
      text = await this.show(ctx, ref.rev, rel).catch(() => null);
      at = ref.start !== undefined ? { start: ref.start, end: ref.end ?? ref.start } : null;
    } else if (r.now) {
      text = await this.worktree(ctx, r.now.path);
      at = r.now;
    } else if (rel !== null) {
      text = await this.worktree(ctx, rel);
      at = ref.start !== undefined ? { start: ref.start, end: ref.end ?? ref.start } : null;
    }
    const lines: { n: number; text: string }[] = [];
    if (text !== null && at) {
      const all = splitLines(text);
      for (let n = Math.max(1, at.start - 3); n <= Math.min(all.length, Math.max(at.start, at.end) + 3); n += 1)
        lines.push({ n, text: all[n - 1]! });
    }
    let diff: string | null = null;
    if (r.state === 'changed' && c.base && c.baseStart !== undefined && r.now && text !== null) {
      const now = splitLines(text).slice(r.now.start - 1, r.now.end);
      diff = [
        `--- a/${rel ?? ref.path}`,
        `+++ b/${r.now.path}`,
        `@@ -${c.baseStart},${c.base.length} +${r.now.start},${now.length} @@`,
        ...c.base.map((l) => `-${l}`),
        ...now.map((l) => `+${l}`),
        '',
      ].join('\n');
    }
    return { lines, diff };
  }

  async fixLines(docPath: AbsPath, refs: CodeRef[]): Promise<number> {
    const file = await this.opts.docs.read(docPath);
    const { refs: resolved } = await this.resolve(docPath, refs);
    let text = file.text;
    let fixed = 0;
    const moves: [string, string][] = [];
    // 从后往前改，前面的偏移不变
    for (const r of [...resolved].sort((a, b) => b.ref.at.from - a.ref.at.from)) {
      const ref = r.ref;
      if (r.state !== 'moved' || !r.now || ref.start === undefined) continue;
      if (text.slice(ref.at.from, ref.at.to) !== ref.raw) continue; // 文档在这之间变了
      const now = r.now;
      let k = 0;
      // 只改路径后面的数字：第一个是起始行，有止行时第二个是止行（:12:5 的列不动）
      const suffix = ref.raw.slice(ref.path.length).replace(/\d+/g, (d) => {
        k += 1;
        if (k === 1) return String(now.start);
        if (k === 2 && ref.end !== undefined) return String(now.end);
        return d;
      });
      text = text.slice(0, ref.at.from) + ref.raw.slice(0, ref.path.length) + suffix + text.slice(ref.at.to);
      fixed += 1;
      const moved = { ...ref, start: now.start, ...(ref.end !== undefined ? { end: now.end } : {}) };
      moves.push([refKey(ref), refKey(moved)]);
    }
    if (fixed === 0) return 0;
    const res = await this.opts.docs.write(docPath, text, { baseHash: file.hash });
    if (!res.ok) throw new AgentDeckError({ code: 'invalid-argument', message: 'The document changed. Reload it and try again.' });
    // 核对过的记录跟着新行号走
    for (const [from, to] of moves) this.store.moveVerified(docPath, from, to);
    return fixed;
  }

  async markVerified(docPath: AbsPath, refs: CodeRef[]): Promise<void> {
    const ctx = await this.context(docPath);
    const records: AnchorVerified[] = [];
    const blobs = new Map<string, string>();
    const at = this.now().toISOString();
    for (const ref of refs) {
      const r = (await this.compute(ctx, ref)).r;
      if (r.state === 'ambiguous' || r.state === 'outside' || r.state === 'gone' || !r.now || ref.rev !== undefined) continue;
      const text = await this.worktree(ctx, r.now.path);
      if (text === null) continue;
      const blob = gitBlobId(text);
      const lines = splitLines(text).slice(r.now.start - 1, r.now.end);
      blobs.set(blob, text);
      records.push({
        docPath,
        refKey: refKey(ref),
        path: r.now.path,
        start: r.now.start,
        end: r.now.end,
        blob,
        linesHash: sha1(lines.join('\n')),
        verifiedAt: at,
      });
    }
    if (records.length === 0) return;
    this.store.putVerified(records, [...blobs].map(([blob, text]) => ({ blob, text })));
    if (this.tracked.has(docPath)) this.schedule(docPath, 0);
  }

  // ---- 不在 contracts 里的 ----

  /** GitEvent：git.status 的 HEAD 变了（提交、切分支、合并）时清掉这个仓库的 blame 缓存，重算开着的文档。 */
  noteGitEvent(e: GitEvent): void {
    if (e.type !== 'git.status') return;
    const repo = e.status.repo;
    const head = e.status.head;
    const known = this.heads.has(repo);
    if (known && this.heads.get(repo) === head) return;
    this.heads.set(repo, head);
    if (!known) return; // 第一次见到这个仓库：没什么可比的
    this.blames.clear();
    for (const [docPath, t] of this.tracked) if (t.repo !== null && samePath(t.repo, repo)) this.schedule(docPath, 300);
  }

  close(): void {
    this.unsubscribe();
    for (const docPath of [...this.tracked.keys()]) this.untrack(docPath);
    if (this.ownWatcher) this.watcher.close();
  }

  // ---- 重算 ----

  private track(docPath: AbsPath): void {
    if (this.tracked.has(docPath)) return;
    this.tracked.set(docPath, { repo: null, timer: null, running: false, again: false, targets: new Map() });
    this.schedule(docPath, 0);
  }

  private untrack(docPath: AbsPath): void {
    const t = this.tracked.get(docPath);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    for (const off of t.targets.values()) off();
    this.tracked.delete(docPath);
  }

  private schedule(docPath: AbsPath, ms: number): void {
    const t = this.tracked.get(docPath);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.timer = null;
      void this.refresh(docPath);
    }, ms);
  }

  /** 同一篇文档同时只算一次；算的时候又有变化，算完再来一次。 */
  private async refresh(docPath: AbsPath): Promise<void> {
    const t = this.tracked.get(docPath);
    if (!t) return;
    if (t.running) {
      t.again = true;
      return;
    }
    t.running = true;
    try {
      await this.resolve(docPath);
    } catch {
      // 文档被删了、git 出错：下一次变化再试
    } finally {
      t.running = false;
      if (t.again && this.tracked.get(docPath) === t) {
        t.again = false;
        this.schedule(docPath, 0);
      }
    }
  }

  /** 盯着这篇文档引用的文件：存盘以后（去抖）重算。只盯工作区里存在的、最多 MAX_TARGETS 个。 */
  private watchTargets(docPath: AbsPath, repo: string | null, resolved: ResolvedRef[]): void {
    const t = this.tracked.get(docPath);
    if (!t) return;
    const want = new Set<string>();
    if (repo)
      for (const r of resolved) {
        const p = r.now?.path ?? (r.state === 'ok' || r.state === 'changed' || r.state === 'gone' ? r.ref.path : null);
        if (p && !isAbsolute(p) && want.size < MAX_TARGETS) want.add(join(repo, p));
      }
    for (const [file, off] of t.targets)
      if (!want.has(file)) {
        off();
        t.targets.delete(file);
      }
    for (const file of want)
      if (!t.targets.has(file)) t.targets.set(file, this.watcher.add(file, () => this.schedule(docPath, this.targetDebounceMs)));
  }

  // ---- 核对一处 ----

  private async context(docPath: AbsPath): Promise<Ctx> {
    const file = await this.opts.docs.read(docPath);
    const docReal = await realpath(docPath).catch(() => resolve(docPath));
    const repo = file.repo ? await realpath(file.repo).catch(() => file.repo) : null;
    const docRel = repo ? toPosix(relative(repo, docReal)) : null;
    const cache = new Map<string, Cached>();
    for (const row of this.store.cache(docPath)) {
      try {
        cache.set(cacheId(row.refKey, row.baseline, row.targetHash), JSON.parse(row.result) as Cached);
      } catch {
        // 读不出来的旧缓存不要
      }
    }
    const ctx: Ctx = {
      docPath,
      docReal,
      docLines: splitLines(file.text),
      repo,
      docRel: docRel !== null && !docRel.startsWith('..') ? docRel : null,
      verified: new Map(this.store.verified(docPath).map((v) => [v.refKey, v])),
      cache,
      rows: new Map(),
      memo: new Map(),
    };
    // blame 按文档内容缓存：同样的内容、git 状态没变时不再问
    if (ctx.repo && ctx.docRel) {
      const key = `${docPath}\0${file.hash}`;
      if (!this.blames.has(key)) {
        if (this.blames.size >= 256) this.blames.clear(); // 改来改去的文档每个版本一条，别无限长
        const repoDir = ctx.repo;
        const rel = ctx.docRel;
        this.blames.set(
          key,
          this.opts.git.blameLines(repoDir, rel).then(
            (b) => b.map((l) => l.commit),
            () => null,
          ),
        );
      }
      ctx.memo.set('blame', this.blames.get(key)!);
    }
    return ctx;
  }

  private async resolveOne(ctx: Ctx, ref: CodeRef): Promise<Computed> {
    const base = await this.baselineOf(ctx, ref);
    const rel = ctx.repo ? relPath(ctx, ref.path) : null;
    // 缓存只用在目标文件存在、不是钉住版本的引用上（钉住的本来就便宜，短路径的候选随文件列表变）
    if (ref.kind === 'repo' && rel !== null && ref.rev === undefined) {
      const text = await this.worktree(ctx, rel);
      if (text !== null) {
        const targetHash = sha1(text);
        const id = cacheId(refKey(ref), base.id, targetHash);
        const hit = ctx.cache.get(id);
        const c = hit ? { r: hit } : await this.compute(ctx, ref);
        if (c.r.state !== 'ambiguous') ctx.rows.set(id, { refKey: refKey(ref), baseline: base.id, targetHash, result: c.r });
        return c;
      }
    }
    return this.compute(ctx, ref);
  }

  /** 这处引用的基准：钉住的 rev > 核对过的记录 > blame 文档这一行的提交 > 工作区。 */
  private async baselineOf(
    ctx: Ctx,
    ref: CodeRef,
  ): Promise<{ id: string; baseline: ResolvedRef['baseline']; verified?: AnchorVerified }> {
    if (ref.rev !== undefined) return { id: `pinned:${ref.rev}`, baseline: { rev: ref.rev, source: 'pinned' } };
    const v = ctx.verified.get(refKey(ref));
    if (v) return { id: `verified:${v.blob}`, baseline: { rev: null, source: 'verified' }, verified: v };
    const blame = (await (ctx.memo.get('blame') as Promise<string[] | null> | undefined)) ?? null;
    const commit = blame?.[ref.at.line - 1];
    if (commit && !ZERO.test(commit)) return { id: `blame:${commit}`, baseline: { rev: commit, source: 'blame' } };
    return { id: 'worktree', baseline: { rev: null, source: 'worktree' } };
  }

  private async compute(ctx: Ctx, ref: CodeRef): Promise<Computed> {
    const b = await this.baselineOf(ctx, ref);
    let baseline = b.baseline;
    if (ref.kind === 'new') return { r: { state: 'outside', baseline, detail: 'A planned file; not checked' } };
    if (ref.kind === 'external') return { r: { state: 'outside', baseline, detail: `From ${ref.source ?? 'another repository'}; not checked` } };
    if (!ctx.repo) return { r: { state: 'outside', baseline, detail: 'This document isn’t in a Git repository' } };
    const rel = relPath(ctx, ref.path);
    if (rel === null) return { r: { state: 'outside', baseline, detail: 'Outside this worktree' } };

    const s = ref.start ?? 1;
    const e = Math.max(ref.end ?? s, s);
    const written = { start: s, end: e };

    // 钉住的版本：不跟着代码走，只看那个版本里有没有这几行（和符号）
    if (ref.rev !== undefined) {
      let text: string | null;
      try {
        text = await this.show(ctx, ref.rev, rel);
      } catch {
        return { r: { state: 'gone', baseline, detail: `${ref.rev} isn’t a commit in this repository` } };
      }
      if (text === null) return { r: { state: 'gone', baseline, detail: `${rel} isn’t in ${ref.rev}` } };
      const lines = splitLines(text);
      if (e > lines.length) return { r: { state: 'gone', baseline, detail: `${rel} has ${lines.length} lines in ${ref.rev}` } };
      if (ref.symbol !== undefined && findSymbol(lines, ref.symbol, s, e) === null)
        return { r: { state: 'gone', baseline, detail: `${ref.symbol} isn’t near these lines in ${ref.rev}`, text: lines[s - 1]! } };
      return { r: { state: 'ok', baseline, now: { path: rel, ...written }, text: lines[s - 1]! } };
    }

    const nowText = await this.worktree(ctx, rel);
    if (nowText === null) return this.missing(ctx, ref, rel, b);
    const now = splitLines(nowText);
    if (ref.start === undefined) return { r: { state: 'ok', baseline, now: { path: rel, start: 1, end: Math.max(1, now.length) } } };

    // 基准那一版的文件和 hunk；blame 的基准里没有这个文件或这几行（文档比代码写得早），退回工作区
    let base: string[] = now;
    let hunks: LineMapHunk[] = [];
    let bs = s;
    let be = e;
    if (b.verified) {
      const text = this.store.blob(b.verified.blob);
      if (text !== null) {
        base = splitLines(text);
        bs = b.verified.start;
        be = b.verified.end;
        hunks = gitBlobId(nowText) === b.verified.blob ? [] : diffLines(base, now);
      } else baseline = { rev: null, source: 'worktree' };
    } else if (baseline.source === 'blame' && baseline.rev) {
      const rev = baseline.rev;
      hunks = await this.lineMap(ctx, rel, rev);
      if (e > oldLength(now.length, hunks)) baseline = { rev: null, source: 'worktree' };
      else if (!touches(hunks, s, e)) {
        // 这几行没被碰过：内容就是现在挪过去的那几行，不用再读基准那一版（省一半的 git 调用）
        const start = mapLine(hunks, s, 'start');
        const c = checkSymbol(now, { kind: 'same', start, end: start + e - s }, ref.symbol);
        const r: Cached = { state: stateOf(c, written), baseline, now: { path: rel, start: c.start, end: c.end } };
        const first = now[start - 1];
        if (first !== undefined) r.text = first;
        if (c.detail !== undefined) r.detail = c.detail;
        return { r, base: now.slice(start - 1, start + e - s), baseStart: s };
      } else {
        const text = await this.show(ctx, rev, rel).catch(() => null);
        const lines = text === null ? null : splitLines(text);
        if (lines && e <= lines.length) base = lines;
        else {
          baseline = { rev: null, source: 'worktree' };
          hunks = [];
        }
      }
    }
    const c = classify(base, now, hunks, bs, be, ref.symbol);
    const text = base[bs - 1];
    const r: Cached = { state: stateOf(c, written), baseline, now: { path: rel, start: c.start, end: c.end } };
    if (text !== undefined) r.text = text;
    if (c.detail !== undefined) r.detail = c.detail;
    else if (r.state === 'changed')
      r.detail = baseline.source === 'verified' ? 'Changed since you marked it as checked' : `Changed since ${short(baseline.rev)}`;
    return { r, base: base.slice(bs - 1, be), baseStart: bs };
  }

  /** 工作区里没有这个文件：改名了（提示新路径）、删了，或者是短路径（列候选）。 */
  private async missing(
    ctx: Ctx,
    ref: CodeRef,
    rel: string,
    b: { baseline: ResolvedRef['baseline'] },
  ): Promise<Computed> {
    const baseline = b.baseline;
    const repo = ctx.repo!;
    const from = baseline.rev ?? 'HEAD';
    const renamed = await this.opts.git.renamedPath?.(repo, rel, from, 'worktree').catch(() => null);
    if (renamed) {
      const s = ref.start ?? 1;
      const e = Math.max(ref.end ?? s, s);
      const nowText = await this.worktree(ctx, renamed);
      let now = { path: renamed, start: s, end: e };
      if (nowText !== null && ref.start !== undefined && baseline.rev) {
        const baseText = await this.show(ctx, baseline.rev, rel).catch(() => null);
        const base = baseText === null ? null : splitLines(baseText);
        if (base && e <= base.length) {
          const hunks = await this.lineMap(ctx, rel, baseline.rev);
          const c = classify(base, splitLines(nowText), hunks, s, e, ref.symbol);
          now = { path: renamed, start: c.start, end: c.end };
        }
      }
      return { r: { state: 'gone', baseline, now, detail: `Renamed to ${renamed}` } };
    }
    const existed = (await this.show(ctx, from, rel).catch(() => null)) !== null;
    if (!existed) {
      const candidates = await this.candidates(ctx, ref, rel);
      if (candidates.length > 0) return { r: { state: 'ambiguous', baseline, now: null, candidates } };
      return { r: { state: 'gone', baseline, detail: `${rel} not found` } };
    }
    return { r: { state: 'gone', baseline, detail: `${rel} was deleted` } };
  }

  /** 短路径、不完整的路径：仓库里以它结尾的文件，按这几行原文和句子里的词排序。 */
  private async candidates(ctx: Ctx, ref: CodeRef, rel: string): Promise<string[]> {
    const files = await this.files(ctx);
    const suffix = `/${rel}`;
    const found = files.filter((f) => f.endsWith(suffix) || f === rel);
    if (found.length <= 1) return found;
    const words = sentenceWords(ctx.docLines[ref.at.line - 1] ?? '', ref.path);
    const s = ref.start ?? 1;
    const e = Math.max(ref.end ?? s, s);
    const scored = await Promise.all(
      found.map(async (f) => {
        const text = await this.worktree(ctx, f);
        if (text === null) return { f, score: -1 };
        const lines = splitLines(text);
        const window = lines
          .slice(Math.max(0, s - 4), e + 3)
          .join('\n')
          .toLowerCase();
        let score = 0;
        for (const w of words) if (window.includes(w)) score += 1;
        if (ref.symbol !== undefined && findSymbol(lines, ref.symbol, s, e) !== null) score += 5;
        if (e > lines.length) score -= 3;
        return { f, score };
      }),
    );
    return scored.sort((a, b) => b.score - a.score || a.f.length - b.f.length || a.f.localeCompare(b.f)).map((x) => x.f);
  }

  // ---- 一次 resolve 里共用的读取 ----

  private once<T>(ctx: Ctx, key: string, fn: () => Promise<T>): Promise<T> {
    let p = ctx.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      ctx.memo.set(key, p);
    }
    return p;
  }

  private worktree(ctx: Ctx, rel: string): Promise<string | null> {
    return this.once(ctx, `wt\0${rel}`, () => readFile(join(ctx.repo!, rel), 'utf8').catch(() => null));
  }

  private show(ctx: Ctx, rev: string, rel: string): Promise<string | null> {
    return this.once(ctx, `show\0${rev}\0${rel}`, () => this.opts.git.showFile(ctx.repo!, rev, rel));
  }

  private lineMap(ctx: Ctx, rel: string, rev: string): Promise<LineMapHunk[]> {
    return this.once(ctx, `map\0${rev}\0${rel}`, () => this.opts.git.lineMap(ctx.repo!, rel, rev, 'worktree'));
  }

  private files(ctx: Ctx): Promise<string[]> {
    return this.once(ctx, 'files', async () => (await this.opts.git.listFiles?.(ctx.repo!).catch(() => null)) ?? []);
  }

  private emit(e: DocEvent): void {
    try {
      this.opts.emit?.(e);
    } catch {
      // 发事件出错不影响核对
    }
  }
}

function toResolved(ref: CodeRef, c: Cached): ResolvedRef {
  const out: ResolvedRef = { ref: { ...ref }, state: c.state, baseline: { ...c.baseline } };
  if (c.text !== undefined && out.ref.text === undefined) out.ref.text = c.text;
  if (c.now !== undefined) out.now = c.now ? { ...c.now } : null;
  if (c.candidates) out.candidates = [...c.candidates];
  if (c.detail !== undefined) out.detail = c.detail;
  return out;
}

/** 内容没变时：位置和文档里写的一样是 ok，不一样是 moved。 */
function stateOf(c: Classified, written: { start: number; end: number }): AnchorState {
  if (c.kind === 'same') return c.start === written.start && c.end === written.end ? 'ok' : 'moved';
  return c.kind;
}

function cacheId(refKey: string, baseline: string, targetHash: string): string {
  return `${refKey}\0${baseline}\0${targetHash}`;
}

function short(rev: string | null): string {
  return rev ? rev.slice(0, 7) : 'the last commit';
}

/** 引用里的路径 → 相对仓库根（posix 分隔符）；在这个 worktree 外面返回 null。./ ../ 开头的相对文档所在目录。 */
function relPath(ctx: Ctx, path: string): string | null {
  let abs: string;
  if (isAbsolute(path)) abs = path;
  else if (path.startsWith('./') || path.startsWith('../')) abs = resolve(dirname(ctx.docReal), path);
  else return toPosix(normalize(path));
  const rel = relative(ctx.repo!, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return toPosix(rel);
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/** 句子里的词（标识符，3 个字符以上，不含路径里的），小写。 */
function sentenceWords(line: string, path: string): Set<string> {
  const inPath = new Set(path.toLowerCase().split(/[^a-z0-9_$]+/));
  const words = new Set<string>();
  for (const m of line.matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
    const w = m[0].toLowerCase();
    if (!inPath.has(w)) words.add(w);
  }
  return words;
}

/** 最多 n 个同时跑，结果按原来的顺序。 */
async function limit<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
