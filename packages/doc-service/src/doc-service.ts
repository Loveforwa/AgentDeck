// DocService 的真实实现（M15 · DC2）：读写工作区里的 .md、盯文件、这次运行里的快照、“谁改的”。
// 需求见设计画布“文档”页 D0 第 5 节（你和 agent 同时改）和 DR-97：文件是唯一的真相，保存带 baseHash，对不上就不写。

import { readdir, readFile, realpath, rename, stat, unlink, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AbsPath, DocAuthor, DocEvent, DocFile, DocService, DocSnapshot, DocWriteResult, GitService } from '@agentdeck/contracts';
import { AgentDeckError } from '@agentdeck/contracts';
import { sha1 } from './hash.ts';
import { DirWatcher } from './watch.ts';

/**
 * doc-service 用到的 git：contracts 的 GitService 的一部分。listFiles（contracts 0.1.22，可选）是仓库里的文件
 * （跟踪的 + 没被忽略的未跟踪文件），相对仓库根；没有时 list 自己走目录。
 */
export type DocGit = Pick<GitService, 'repoRoot' | 'listFiles'>;

export interface DocServiceOptions {
  git: DocGit;
  emit?: (event: DocEvent) => void;
  /** 这些目录下的文件只读（AgentDeck 的数据目录：集群汇报）。 */
  readOnlyRoots?: AbsPath[];
  /** 文件变了以后等多久再读（去抖），默认 200ms。 */
  debounceMs?: number;
  /** agent 的写入和磁盘变化相差多少以内算它改的，默认 2000ms。 */
  attributeWithinMs?: number;
  /** 每个文件最多留几份快照，默认 50。 */
  maxSnapshots?: number;
  watcher?: DirWatcher;
  now?: () => number;
}

/** 文档变化的内部通知（给 CodeAnchorService：开了窗口就核对、文件变了就重算）。 */
export type DocChange = { type: 'watch' | 'unwatch' | 'changed'; path: AbsPath };

interface Snap {
  snap: DocSnapshot;
  text: string;
  /** 毫秒，用来对 agent 的写入。 */
  ms: number;
}

interface Tracked {
  /** 调用方给的路径（发事件用它）。 */
  path: AbsPath;
  snaps: Snap[];
  /** 上次读到 / 写下的内容哈希。 */
  hash: string | null;
  /** 我们自己刚写下的哈希：盯文件时看到它就知道是自己存的。 */
  ownHash: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  unwatch: (() => void) | null;
}

const LIST_LIMIT = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

export class LocalDocService implements DocService {
  private readonly files = new Map<string, Tracked>();
  private readonly agentWrites = new Map<string, { author: DocAuthor; ms: number }[]>();
  private readonly listeners = new Set<(c: DocChange) => void>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly repos = new Map<string, Promise<AbsPath | null>>();
  private readonly watcher: DirWatcher;
  private readonly ownWatcher: boolean;
  private readonly debounceMs: number;
  private readonly within: number;
  private readonly maxSnapshots: number;
  private readonly now: () => number;

  constructor(private readonly opts: DocServiceOptions) {
    this.watcher = opts.watcher ?? new DirWatcher();
    this.ownWatcher = opts.watcher === undefined;
    this.debounceMs = opts.debounceMs ?? 200;
    this.within = opts.attributeWithinMs ?? 2000;
    this.maxSnapshots = opts.maxSnapshots ?? 50;
    this.now = opts.now ?? Date.now;
  }

  async read(path: AbsPath): Promise<DocFile> {
    const key = await canonical(path);
    let text: string;
    let mtime: string;
    try {
      const st = await stat(key);
      if (!st.isFile()) throw new Error('not a file');
      text = await readFile(key, 'utf8');
      mtime = st.mtime.toISOString();
    } catch {
      throw new AgentDeckError({ code: 'not-found', message: `No such document: ${path}` });
    }
    const hash = sha1(text);
    const t = this.tracked(key, path);
    // 读进来的版本也存一份：“你上次看过以后改了什么”要拿它比。
    // 盯着的文件在去抖期间被读到了新内容：算作一次磁盘变化（照样认是谁改的、发 doc.changed），免得盯文件那边以为没变
    if (t.hash !== hash) {
      const first = t.hash === null;
      t.hash = hash;
      const by = first ? null : hash === t.ownHash ? ({ kind: 'me' } as const) : this.agentFor(key);
      this.addSnapshot(t, text, hash, by);
      if (!first) this.changed(t, hash, by);
    }
    return { path, text, hash, mtime, repo: await this.repoOf(dirname(key)), readOnly: await this.readOnly(key) };
  }

  async write(path: AbsPath, text: string, opts: { baseHash: string }): Promise<DocWriteResult> {
    const key = await canonical(path);
    if (await this.readOnly(key)) throw new AgentDeckError({ code: 'invalid-argument', message: 'This document is read-only' });
    return this.lock(key, async () => {
      const current = await readFile(key, 'utf8').catch(() => null);
      // 文件还不存在时按空文档算（New doc… 建文件时 baseHash 是空文本的哈希）
      if (sha1(current ?? '') !== opts.baseHash) {
        if (current === null) throw new AgentDeckError({ code: 'not-found', message: `No such document: ${path}` });
        return { ok: false, conflict: { theirs: await this.read(path) } };
      }
      const mode = await stat(key).then(
        (s) => s.mode & 0o7777,
        () => undefined,
      );
      // 临时文件放在同一个目录里，rename 才是原子的；名字以点开头，git status 里一闪而过也不显眼
      const tmp = join(dirname(key), `.${basename(key)}.agentdeck-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
      try {
        await writeFile(tmp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
        await rename(tmp, key);
      } catch (e) {
        await unlink(tmp).catch(() => undefined);
        throw new AgentDeckError({ code: 'internal', message: `Couldn’t save ${path}`, detail: e instanceof Error ? e.message : String(e) });
      }
      const hash = sha1(text);
      const t = this.tracked(key, path);
      t.ownHash = hash;
      if (t.hash !== hash) {
        t.hash = hash;
        this.addSnapshot(t, text, hash, { kind: 'me' });
        this.changed(t, hash, { kind: 'me' });
      }
      return { ok: true, hash };
    });
  }

  async watch(path: AbsPath): Promise<void> {
    const key = await canonical(path);
    const t = this.tracked(key, path);
    if (t.unwatch) return;
    if (t.hash === null) await this.read(path); // 不存在时抛 not-found
    t.unwatch = this.watcher.add(key, () => this.schedule(key));
    this.notify({ type: 'watch', path: t.path });
  }

  async unwatch(path: AbsPath): Promise<void> {
    const key = await canonical(path);
    const t = this.files.get(key);
    if (!t?.unwatch) return;
    t.unwatch();
    t.unwatch = null;
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    this.notify({ type: 'unwatch', path: t.path });
  }

  async list(root: AbsPath): Promise<{ path: AbsPath; title: string | null }[]> {
    const base = await realpath(root).catch(() => resolve(root));
    let rel: string[] | null = null;
    if (this.opts.git.listFiles) {
      const repo = await this.repoOf(base);
      if (repo) {
        const all = await this.opts.git.listFiles(repo).catch(() => null);
        if (all) {
          const inside = relative(repo, base);
          rel = all
            .map((f) => relative(base, join(repo, f)))
            .filter((f) => inside === '' || !f.startsWith('..'));
        }
      }
    }
    rel ??= await walk(base);
    const docs = rel
      .filter((f) => /\.(md|markdown)$/i.test(f) && !f.split(/[\\/]/).includes('node_modules'))
      .slice(0, LIST_LIMIT)
      .sort();
    return Promise.all(
      docs.map(async (f) => {
        const full = join(base, f);
        const head = await readFile(full, 'utf8').then(
          (t) => t.slice(0, 8192),
          () => '',
        );
        return { path: full, title: /^#\s+(.+?)\s*#*\s*$/m.exec(head)?.[1] ?? null };
      }),
    );
  }

  async snapshots(path: AbsPath): Promise<DocSnapshot[]> {
    const t = this.files.get(await canonical(path));
    return (t?.snaps ?? []).map((s) => ({ ...s.snap, by: s.snap.by ? { ...s.snap.by } : null }));
  }

  async snapshot(path: AbsPath, hash: string): Promise<string | null> {
    const t = this.files.get(await canonical(path));
    const snaps = t?.snaps ?? [];
    for (let i = snaps.length - 1; i >= 0; i -= 1) if (snaps[i]!.snap.hash === hash) return snaps[i]!.text;
    return null;
  }

  // ---- 不在 contracts 里的 ----

  /**
   * agent 改了一个文件（PostToolUse 钩子里的 tool_input.file_path，由 apps/desktop 喂进来）。
   * 磁盘变化和它相差 attributeWithinMs 以内就记成它改的；变化先到、钩子后到时，补上最近那份快照的 by，再发一次 doc.changed。
   */
  noteAgentWrite(path: AbsPath, author: DocAuthor): void {
    void canonical(path).then((key) => {
      const ms = this.now();
      const list = (this.agentWrites.get(key) ?? []).filter((w) => ms - w.ms <= this.within * 2);
      list.push({ author, ms });
      this.agentWrites.set(key, list);
      const t = this.files.get(key);
      const last = t?.snaps.at(-1);
      if (t && last && last.snap.by === null && t.snaps.length > 1 && ms - last.ms <= this.within) {
        last.snap.by = author;
        if (t.unwatch) this.emit({ type: 'doc.changed', path: t.path, hash: last.snap.hash, by: { ...author } });
      }
    });
  }

  /** 订阅内部通知。 */
  subscribe(listener: (c: DocChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 仓库根目录的缓存清掉（git init、worktree 搬家之后）。 */
  forgetRepos(): void {
    this.repos.clear();
  }

  /** 文档所在的仓库根（worktree 根）；不在仓库里为 null。 */
  repoOf(dir: AbsPath): Promise<AbsPath | null> {
    let p = this.repos.get(dir);
    if (!p) {
      p = this.opts.git.repoRoot(dir).catch(() => null);
      this.repos.set(dir, p);
    }
    return p;
  }

  isWatched(path: AbsPath): boolean {
    for (const t of this.files.values()) if (t.path === path && t.unwatch) return true;
    return false;
  }

  close(): void {
    for (const t of this.files.values()) {
      t.unwatch?.();
      if (t.timer) clearTimeout(t.timer);
    }
    this.files.clear();
    if (this.ownWatcher) this.watcher.close();
  }

  // ---- 内部 ----

  private tracked(key: string, path: AbsPath): Tracked {
    let t = this.files.get(key);
    if (!t) {
      t = { path, snaps: [], hash: null, ownHash: null, timer: null, unwatch: null };
      this.files.set(key, t);
    }
    return t;
  }

  private schedule(key: string): void {
    const t = this.files.get(key);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.timer = null;
      void this.diskChanged(key);
    }, this.debounceMs);
  }

  private async diskChanged(key: string): Promise<void> {
    const t = this.files.get(key);
    if (!t?.unwatch) return;
    // 删掉了、或者 rename 的中间：不算一次变化，等下一次事件
    const text = await readFile(key, 'utf8').catch(() => null);
    if (text === null) return;
    const hash = sha1(text);
    if (hash === t.hash) return;
    t.hash = hash;
    const by: DocAuthor | null = hash === t.ownHash ? { kind: 'me' } : this.agentFor(key);
    this.addSnapshot(t, text, hash, by);
    this.changed(t, hash, by);
  }

  private agentFor(key: string): DocAuthor | null {
    const ms = this.now();
    const hit = (this.agentWrites.get(key) ?? []).filter((w) => Math.abs(ms - w.ms) <= this.within + this.debounceMs).at(-1);
    return hit ? hit.author : null;
  }

  private addSnapshot(t: Tracked, text: string, hash: string, by: DocAuthor | null): void {
    const ms = this.now();
    t.snaps.push({ snap: { hash, at: new Date(ms).toISOString(), by }, text, ms });
    while (t.snaps.length > this.maxSnapshots) t.snaps.shift();
  }

  private changed(t: Tracked, hash: string, by: DocAuthor | null): void {
    if (t.unwatch) this.emit({ type: 'doc.changed', path: t.path, hash, by: by ? { ...by } : null });
    this.notify({ type: 'changed', path: t.path });
  }

  private emit(e: DocEvent): void {
    try {
      this.opts.emit?.(e);
    } catch {
      // 发事件出错不影响读写
    }
  }

  private notify(c: DocChange): void {
    for (const l of this.listeners) {
      try {
        l(c);
      } catch {
        // 监听者的错不影响别人
      }
    }
  }

  private async readOnly(key: string): Promise<boolean> {
    for (const root of this.opts.readOnlyRoots ?? []) {
      const r = await realpath(root).catch(() => resolve(root));
      const rel = relative(r, key);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true;
    }
    return access(key, constants.W_OK).then(
      () => false,
      (e: NodeJS.ErrnoException) => e.code !== 'ENOENT',
    );
  }

  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return next;
  }
}

/** 绝对路径的规范写法：目录 realpath（macOS 的 /var → /private/var、符号链接），文件名不动（文件可能还不存在）。 */
export async function canonical(path: AbsPath): Promise<string> {
  const abs = resolve(path);
  const real = await realpath(abs).catch(() => null);
  if (real) return real;
  const dir = await realpath(dirname(abs)).catch(() => dirname(abs));
  return join(dir, basename(abs));
}

/** 不在 git 仓库里时：自己走目录（跳过 node_modules、.git、点开头的目录），最多 LIST_LIMIT 个文件。 */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length > 0 && out.length < LIST_LIMIT) {
    const rel = queue.shift()!;
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = rel === '' ? e.name : `${rel}${sep}${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push(p);
      } else if (e.isFile()) out.push(p);
    }
  }
  return out;
}
