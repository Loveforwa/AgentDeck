// node-pty 1.1.0 的预编译 spawn-helper 装完没有执行权限（F7 问题 14），直接用会报 posix_spawnp failed。
// pnpm install 后由本包的 postinstall 调一次；运行时 src/pty.ts 也会再检查一次（打包后的应用里没有 postinstall）。
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
try {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const dir of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release']) {
    const file = path.join(root, dir, 'spawn-helper');
    if (!existsSync(file)) continue;
    const mode = statSync(file).mode;
    if ((mode & 0o111) !== 0o111) chmodSync(file, mode | 0o755);
  }
} catch {
  // 没装 node-pty（例如只装了一部分依赖）时不报错
}
