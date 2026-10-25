// node-pty：真正的显示连接是一个跑 `tmux attach-session` 的 pty（F7 的结论）。
// node-pty 1.1.0 的预编译 spawn-helper 装完没有执行权限（F7 问题 14），第一次用之前补上。
// 打包时（第 3 波）：node-pty 要放进 asar.unpacked，spawn-helper 要保留 0755，见 AGENTS.md。

import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { IPty, IPtyForkOptions } from 'node-pty';

export type { IPty } from 'node-pty';

/** 只用到 node-pty 的 spawn；测试可以换掉。 */
export interface PtyModule {
  spawn(file: string, args: string[], options: IPtyForkOptions): IPty;
}

// 不叫 require：electron-vite（vite:esm-shim）会给用到 require( 的 ESM 产物在顶层注入 `const require = createRequire(...)`，
// 同名就是重复声明，终端进程一启动就崩（IS-09）。起个不会撞的名字，构建配置里不用再绕。
const nodeRequire = createRequire(import.meta.url);

/** 给 spawn-helper 补执行权限。返回检查过的文件（测试用）。 */
export function ensureSpawnHelperExecutable(): string[] {
  const checked: string[] = [];
  let root: string;
  try {
    root = dirname(nodeRequire.resolve('node-pty/package.json'));
  } catch {
    return checked;
  }
  // 打包后 node-pty 在 app.asar 里时，可执行文件实际在 app.asar.unpacked 下。
  const roots = root.includes('app.asar') && !root.includes('app.asar.unpacked') ? [root.replace('app.asar', 'app.asar.unpacked'), root] : [root];
  for (const r of roots) {
    for (const dir of [`prebuilds/${process.platform}-${process.arch}`, 'build/Release']) {
      const file = join(r, dir, 'spawn-helper');
      if (!existsSync(file)) continue;
      checked.push(file);
      try {
        const mode = statSync(file).mode;
        if ((mode & 0o111) !== 0o111) chmodSync(file, mode | 0o755);
      } catch {
        // 只读文件系统（签名过的 .app）上改不了：打包时就得保证权限对，见 AGENTS.md
      }
    }
  }
  return checked;
}

let loaded: PtyModule | null = null;

export function loadNodePty(): PtyModule {
  if (loaded) return loaded;
  ensureSpawnHelperExecutable();
  loaded = nodeRequire('node-pty') as PtyModule;
  return loaded;
}
