// 盯文件：一个目录一个 fs.watch，按文件名分给各个监听者。
// 盯目录而不是文件本身：agent 的写入工具和我们自己的保存都是“临时文件 + rename”，换了 inode 以后盯文件的 watcher 就失效了。

import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

type Listener = () => void;

export class DirWatcher {
  private readonly dirs = new Map<string, { watcher: FSWatcher; files: Map<string, Set<Listener>> }>();

  /** 开始盯一个文件，返回取消的函数。目录不存在或盯不了时什么都不做（返回的函数也什么都不做）。 */
  add(file: string, listener: Listener): () => void {
    const dir = dirname(file);
    const name = basename(file);
    let entry = this.dirs.get(dir);
    if (!entry) {
      const files = new Map<string, Set<Listener>>();
      let watcher: FSWatcher;
      try {
        // persistent: false：不因为盯着文件而让进程不退出（测试、退出时）
        watcher = watch(dir, { persistent: false }, (_event, changed) => {
          const targets = changed ? [files.get(changed.toString())] : [...files.values()];
          for (const set of targets) for (const l of set ?? []) l();
        });
      } catch {
        return () => {};
      }
      watcher.on('error', () => this.drop(dir));
      entry = { watcher, files };
      this.dirs.set(dir, entry);
    }
    const set = entry.files.get(name) ?? new Set<Listener>();
    set.add(listener);
    entry.files.set(name, set);
    return () => {
      const e = this.dirs.get(dir);
      const s = e?.files.get(name);
      if (!e || !s) return;
      s.delete(listener);
      if (s.size === 0) e.files.delete(name);
      if (e.files.size === 0) this.drop(dir);
    };
  }

  /** 现在盯着几个目录（测试用）。 */
  get size(): number {
    return this.dirs.size;
  }

  close(): void {
    for (const dir of [...this.dirs.keys()]) this.drop(dir);
  }

  private drop(dir: string): void {
    const e = this.dirs.get(dir);
    if (!e) return;
    this.dirs.delete(dir);
    e.watcher.close();
  }
}
