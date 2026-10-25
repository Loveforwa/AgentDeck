// electron-builder 的 afterPack（签名之前）：检查打出来的 .app 里运行时要的东西都在、权限对（IS-36）。少了就让打包失败，
// 免得做出一个打开以后才发现终端起不来、数据库打不开的 dmg。
const { chmodSync, existsSync, rmSync, statSync } = require('node:fs');
const { join } = require('node:path');

/** electron-builder 的 Arch 枚举 → node 的 process.arch。 */
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = ARCH[context.arch] ?? String(context.arch);
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const res = join(app, 'Contents/Resources');
  const unpacked = join(res, 'app.asar.unpacked/node_modules');
  const problems = [];

  for (const f of ['app.asar', 'tmux.conf', 'agentdeck-notify.mjs', 'agentdeck-pi-extension.mjs']) {
    if (!existsSync(join(res, f))) problems.push(`missing Resources/${f}`);
  }
  const sqlite = join(unpacked, `better-sqlite3/prebuilds/darwin-${arch}.node`);
  if (!existsSync(sqlite)) problems.push(`missing ${sqlite}`);
  const ptyDir = join(unpacked, `node-pty/prebuilds/darwin-${arch}`);
  if (!existsSync(join(ptyDir, 'pty.node'))) problems.push(`missing ${ptyDir}/pty.node`);
  const helper = join(ptyDir, 'spawn-helper');
  if (!existsSync(helper)) problems.push(`missing ${helper}`);
  else {
    // 签名之后就不能再改了：这里保证 0755（预编译包里没有执行权限，F7 问题 14）
    const mode = statSync(helper).mode;
    if ((mode & 0o755) !== 0o755) chmodSync(helper, mode | 0o755);
  }

  // .stage/app 里两个架构的预编译都有（两个架构共用一份），这里删掉另一个架构的，签名之前删
  const other = arch === 'arm64' ? 'x64' : arch === 'x64' ? 'arm64' : null;
  if (other) {
    rmSync(join(unpacked, `better-sqlite3/prebuilds/darwin-${other}.node`), { force: true });
    rmSync(join(unpacked, `node-pty/prebuilds/darwin-${other}`), { recursive: true, force: true });
  }

  if (problems.length > 0) throw new Error(`[after-pack] ${app} is incomplete:\n  ${problems.join('\n  ')}`);
  console.log(`[after-pack] ${arch}: resources, native modules and spawn-helper (0755) are in place`);
};
