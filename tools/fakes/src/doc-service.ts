// DocService 和 CodeAnchorService 的假实现（M15 · DC0）。
// FakeDocService：内存里的文件。write 带 baseHash，对不上返回 conflict；watch 着的文件变了发 doc.changed；每次变化存一份快照。
// FakeCodeAnchorService：用 contracts 的 parseCodeRefs 读出引用，状态按 setState 预置的固定表回（没预置的算 ok，new / external 算 outside）。

import { parseCodeRefs } from '@agentdeck/contracts';
import type {
  AbsPath,
  AnchorState,
  AnchorSummary,
  CodeAnchorService,
  CodeRef,
  DocAuthor,
  DocFile,
  DocService,
  DocSnapshot,
  DocWriteResult,
  ResolvedRef,
} from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';
import { clone, fail, nowIso } from './util.ts';

/** 假的内容哈希（FNV-1a，十六进制）。真实现用 sha1；假实现只要同样的文字得到同样的值。 */
export function fakeHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

interface StoredFile {
  text: string;
  mtime: string;
  repo: AbsPath | null;
  readOnly: boolean;
  snapshots: { snap: DocSnapshot; text: string }[];
}

const MAX_SNAPSHOTS = 50;

export class FakeDocService implements DocService {
  readonly bus: FakeEventBus;
  readonly watching = new Set<AbsPath>();
  private readonly files = new Map<AbsPath, StoredFile>();

  constructor(opts: { bus?: FakeEventBus } = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
  }

  async read(path: AbsPath): Promise<DocFile> {
    return this.toFile(path, this.require(path));
  }

  async write(path: AbsPath, text: string, opts: { baseHash: string }): Promise<DocWriteResult> {
    const f = this.require(path);
    if (f.readOnly) fail('invalid-argument', 'This document is read-only');
    if (fakeHash(f.text) !== opts.baseHash) return { ok: false, conflict: { theirs: this.toFile(path, f) } };
    this.change(path, f, text, { kind: 'me' });
    return { ok: true, hash: fakeHash(text) };
  }

  async watch(path: AbsPath): Promise<void> {
    this.require(path);
    this.watching.add(path);
  }

  async unwatch(path: AbsPath): Promise<void> {
    this.watching.delete(path);
  }

  async list(root: AbsPath): Promise<{ path: AbsPath; title: string | null }[]> {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return [...this.files.entries()]
      .filter(([p]) => p.startsWith(prefix) && p.endsWith('.md') && !p.includes('/node_modules/'))
      .map(([p, f]) => ({ path: p, title: /^#\s+(.+)$/m.exec(f.text)?.[1]?.trim() ?? null }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async snapshots(path: AbsPath): Promise<DocSnapshot[]> {
    return clone(this.require(path).snapshots.map((s) => s.snap));
  }

  async snapshot(path: AbsPath, hash: string): Promise<string | null> {
    return this.files.get(path)?.snapshots.find((s) => s.snap.hash === hash)?.text ?? null;
  }

  // ---- 假实现专用 ----

  /** 放一个文件（覆盖已有的，不算一次修改）。 */
  setFile(path: AbsPath, text: string, opts: { repo?: AbsPath | null; readOnly?: boolean } = {}): void {
    const at = nowIso();
    this.files.set(path, {
      text,
      mtime: at,
      repo: opts.repo ?? null,
      readOnly: opts.readOnly ?? false,
      snapshots: [{ snap: { hash: fakeHash(text), at, by: null }, text }],
    });
  }

  /** 别人（agent）改了磁盘上的文件：之后你带旧 baseHash 写会冲突；watch 着时发 doc.changed。 */
  externalEdit(path: AbsPath, text: string, by: DocAuthor | null = null): void {
    this.change(path, this.require(path), text, by);
  }

  /** 同步读当前内容（给 FakeCodeAnchorService 用）。 */
  textOf(path: AbsPath): string {
    return this.require(path).text;
  }

  private change(path: AbsPath, f: StoredFile, text: string, by: DocAuthor | null): void {
    const at = nowIso();
    f.text = text;
    f.mtime = at;
    const hash = fakeHash(text);
    f.snapshots.push({ snap: { hash, at, by }, text });
    if (f.snapshots.length > MAX_SNAPSHOTS) f.snapshots.shift();
    if (this.watching.has(path)) this.bus.emit({ type: 'doc.changed', path, hash, by: clone(by) });
  }

  private toFile(path: AbsPath, f: StoredFile): DocFile {
    return { path, text: f.text, hash: fakeHash(f.text), mtime: f.mtime, repo: f.repo, readOnly: f.readOnly };
  }

  private require(path: AbsPath): StoredFile {
    const f = this.files.get(path);
    if (!f) fail('not-found', `No such document: ${path}`);
    return f;
  }
}

const STATES: readonly AnchorState[] = ['ok', 'moved', 'changed', 'gone', 'ambiguous', 'outside'];

export interface FakeAnchorEntry {
  state: AnchorState;
  now?: { path: string; start: number; end: number } | null;
  candidates?: string[];
  detail?: string;
}

export class FakeCodeAnchorService implements CodeAnchorService {
  readonly bus: FakeEventBus;
  /** markVerified 记下的（文档路径 → raw）。 */
  readonly verified = new Map<AbsPath, Set<string>>();
  private readonly docs: FakeDocService;
  private readonly table = new Map<string, FakeAnchorEntry>();

  constructor(opts: { docs: FakeDocService; bus?: FakeEventBus }) {
    this.docs = opts.docs;
    this.bus = opts.bus ?? opts.docs.bus;
  }

  async resolve(docPath: AbsPath, refs?: CodeRef[]): Promise<{ refs: ResolvedRef[]; summary: AnchorSummary }> {
    const list = refs ?? parseCodeRefs(this.docs.textOf(docPath));
    const resolved = list.map((ref) => this.resolveOne(docPath, ref));
    const counts = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<AnchorState, number>;
    for (const r of resolved) counts[r.state] += 1;
    const summary: AnchorSummary = { total: resolved.length, counts, checkedAt: nowIso() };
    if (refs === undefined) this.bus.emit({ type: 'doc.anchors', path: docPath, summary: clone(summary) });
    return { refs: resolved, summary };
  }

  async peek(docPath: AbsPath, ref: CodeRef): Promise<{ lines: { n: number; text: string }[]; diff: string | null }> {
    const r = this.resolveOne(docPath, ref);
    const start = r.now?.start ?? ref.start ?? 1;
    const end = r.now?.end ?? ref.end ?? start;
    const lines = [];
    for (let n = Math.max(1, start - 3); n <= end + 3; n += 1) lines.push({ n, text: `// ${ref.path}:${n}` });
    return { lines, diff: r.state === 'changed' ? `@@ -${ref.start ?? 1} +${start} @@\n-old\n+new\n` : null };
  }

  async fixLines(docPath: AbsPath, refs: CodeRef[]): Promise<number> {
    const file = await this.docs.read(docPath);
    let text = file.text;
    let fixed = 0;
    // 从后往前改，前面的偏移不变
    for (const ref of [...refs].sort((a, b) => b.at.from - a.at.from)) {
      const r = this.resolveOne(docPath, ref);
      if (r.state !== 'moved' || !r.now || ref.start === undefined) continue;
      const raw = text.slice(ref.at.from, ref.at.to);
      // 只改路径后面的数字：第一个是起始行，有止行时第二个是止行（:12:5 的列不动）
      const now = r.now;
      let k = 0;
      const suffix = raw.slice(ref.path.length).replace(/\d+/g, (d) => {
        k += 1;
        if (k === 1) return String(now.start);
        if (k === 2 && ref.end !== undefined) return String(now.end);
        return d;
      });
      text = text.slice(0, ref.at.from) + raw.slice(0, ref.path.length) + suffix + text.slice(ref.at.to);
      fixed += 1;
    }
    if (fixed > 0) {
      const res = await this.docs.write(docPath, text, { baseHash: file.hash });
      if (!res.ok) fail('invalid-argument', 'The document changed. Reload it and try again.');
    }
    return fixed;
  }

  async markVerified(docPath: AbsPath, refs: CodeRef[]): Promise<void> {
    const set = this.verified.get(docPath) ?? new Set<string>();
    for (const r of refs) {
      set.add(r.raw);
      this.table.delete(this.key(docPath, r.raw));
    }
    this.verified.set(docPath, set);
  }

  // ---- 假实现专用 ----

  /** 预置一处引用的状态（按文档路径 + 引用原文 raw）。 */
  setState(docPath: AbsPath, raw: string, entry: FakeAnchorEntry): void {
    this.table.set(this.key(docPath, raw), clone(entry));
  }

  private resolveOne(docPath: AbsPath, ref: CodeRef): ResolvedRef {
    const verified = this.verified.get(docPath)?.has(ref.raw) ?? false;
    const baseline: ResolvedRef['baseline'] = ref.rev
      ? { rev: ref.rev, source: 'pinned' }
      : verified
        ? { rev: 'verified', source: 'verified' }
        : { rev: 'HEAD', source: 'blame' };
    if (ref.kind !== 'repo') return { ref: clone(ref), state: 'outside', baseline };
    const e = this.table.get(this.key(docPath, ref.raw));
    const r: ResolvedRef = { ref: clone(ref), state: e?.state ?? 'ok', baseline };
    if (e?.now !== undefined) r.now = clone(e.now);
    if (e?.candidates) r.candidates = [...e.candidates];
    if (e?.detail !== undefined) r.detail = e.detail;
    return r;
  }

  private key(docPath: AbsPath, raw: string): string {
    return `${docPath}\0${raw}`;
  }
}
