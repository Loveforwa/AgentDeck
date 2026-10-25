// pnpm dist（IS-36）：构建 → 准备 .stage/app → electron-builder 打 macOS 的 .app 和 .dmg，放进 apps/desktop/dist/。
//
//   node scripts/dist.mjs              arm64 和 x64 两个 dmg
//   node scripts/dist.mjs --arm64      只打 arm64（或 --x64）
//   node scripts/dist.mjs --dir        只出 .app，不做 dmg（快，本机试用）
//
// 用 electron-builder 的 JS 接口而不是命令行：projectDir 要指向 .stage/app，配置里的路径是绝对的（见 electron-builder.config.cjs）。
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(desktop, 'package.json'));
const args = new Set(process.argv.slice(2));

if (process.platform !== 'darwin') {
  console.error('[dist] AgentDeck is packaged for macOS only (docs/decisions.md); run this on a Mac');
  process.exit(1);
}

function run(cmd, cmdArgs) {
  const res = spawnSync(cmd, cmdArgs, { cwd: desktop, stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

// 1. 普通的生产构建（不能用 e2e 的那份：它把 import.meta.env.DEV 定义成 true）
run(process.execPath, [join(desktop, 'node_modules/electron-vite/bin/electron-vite.js'), 'build']);
// 2. 准备 electron-builder 的 app 目录
run(process.execPath, [join(desktop, 'scripts/stage-app.mjs')]);

// 3. electron-builder
const { build, Platform, Arch } = require('electron-builder');
const archs = [];
if (args.has('--arm64')) archs.push(Arch.arm64);
if (args.has('--x64')) archs.push(Arch.x64);
if (archs.length === 0) archs.push(Arch.arm64, Arch.x64);
const target = args.has('--dir') ? 'dir' : 'dmg';

await build({
  projectDir: join(desktop, '.stage/app'),
  config: require(join(desktop, 'electron-builder.config.cjs')),
  targets: Platform.MAC.createTarget(target, ...archs),
  publish: 'never',
});

const dist = join(desktop, 'dist');
for (const name of readdirSync(dist)) {
  if (!name.endsWith('.dmg')) continue;
  const mb = (statSync(join(dist, name)).size / 1024 / 1024).toFixed(1);
  console.log(`[dist] ${join(dist, name)} (${mb} MB)`);
}
