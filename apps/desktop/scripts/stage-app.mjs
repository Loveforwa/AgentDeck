// 打包前准备 electron-builder 的 app 目录（IS-36）：apps/desktop/.stage/app/
//
//   package.json   只有运行要的字段，dependencies 只有两个原生模块
//   out/           electron-vite build 的产物（@agentdeck/* 都已经打进去了）
//   node_modules/  better-sqlite3、node-pty 的运行文件：lib、macOS 的预编译 .node、spawn-helper
//
// 为什么不让 electron-builder 直接打 apps/desktop：这个包的 dependencies 里是一堆 workspace 的 TS 源码包（已经打进 out/），
// electron-builder 会顺着 pnpm 的依赖树把它们和它们的依赖（react、xterm……）都复制进 app.asar，又大又容易出错。
// 两个原生模块都是 N-API 预编译（docs/research-log.md DR-27），不用按 Electron 重新编译，只要把文件放对位置。
//
// 用法：node scripts/stage-app.mjs（pnpm dist 会先 build 再调它）。
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(desktop, '.stage', 'app');
const require = createRequire(join(desktop, 'package.json'));
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));

if (!existsSync(join(desktop, 'out', 'main', 'index.js'))) {
  console.error('[stage] apps/desktop/out is missing; run `pnpm --filter @agentdeck/desktop build` first');
  process.exit(1);
}

rmSync(join(desktop, '.stage'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(desktop, 'out'), join(stage, 'out'), { recursive: true });

/** 原生模块里要带的文件（相对模块根目录）：其余（C++ 源码、deps、Windows / Linux 的预编译）不要。 */
const NATIVE = {
  'better-sqlite3': (rel) => rel === 'LICENSE' || rel.startsWith('lib/') || /^prebuilds\/darwin-(arm64|x64)\.node$/.test(rel),
  'node-pty': (rel) =>
    rel === 'LICENSE' ||
    (rel.startsWith('lib/') && !/\.test\.js$/.test(rel) && !rel.endsWith('.map')) ||
    /^prebuilds\/darwin-(arm64|x64)\//.test(rel),
};

function walk(dir, root = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else out.push(relative(root, full));
  }
  return out;
}

const dependencies = {};
for (const [name, keep] of Object.entries(NATIVE)) {
  const src = realpathSync(dirname(require.resolve(`${name}/package.json`)));
  const dst = join(stage, 'node_modules', name);
  const modPkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  let count = 0;
  for (const rel of walk(src)) {
    if (!keep(rel)) continue;
    mkdirSync(dirname(join(dst, rel)), { recursive: true });
    cpSync(join(src, rel), join(dst, rel));
    count++;
  }
  // 只留运行要的字段：没有 dependencies（node-addon-api 只在编译时用）、没有 install 脚本和 gypfile，electron-builder 不会想去重新编译
  const slim = { name: modPkg.name, version: modPkg.version, license: modPkg.license, main: modPkg.main };
  writeFileSync(join(dst, 'package.json'), `${JSON.stringify(slim, null, 2)}\n`);
  dependencies[name] = modPkg.version;
  console.log(`[stage] ${name}@${modPkg.version}: ${count} files`);
}

// node-pty 的 spawn-helper 预编译包里没有执行权限（tmux-host/AGENTS.md「给组装」第 5 条），签名后的 .app 里改不了，这里先补上。
for (const arch of ['arm64', 'x64']) {
  const helper = join(stage, 'node_modules/node-pty/prebuilds', `darwin-${arch}`, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}

writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'agentdeck',
      productName: 'AgentDeck',
      version: pkg.version,
      description: 'A whiteboard for running coding agents side by side in real terminals',
      author: 'AgentDeck',
      license: 'UNLICENSED',
      type: 'module',
      main: './out/main/index.js',
      dependencies,
    },
    null,
    2,
  )}\n`,
);
// electron-builder 按 lock 文件认包管理器：有 package-lock.json 就当 npm 项目，只在这个目录里收依赖（npm ls 只看到上面两个）。
// 没有它时会认出外面的 pnpm workspace，把 apps/desktop 的整棵依赖树收进 app.asar（见 electron-builder.config.cjs）。
const lockPackages = { '': { name: 'agentdeck', version: pkg.version, dependencies } };
for (const [name, version] of Object.entries(dependencies)) lockPackages[`node_modules/${name}`] = { version };
writeFileSync(
  join(stage, 'package-lock.json'),
  `${JSON.stringify({ name: 'agentdeck', version: pkg.version, lockfileVersion: 3, requires: true, packages: lockPackages }, null, 2)}\n`,
);
console.log(`[stage] ready: ${stage}`);
