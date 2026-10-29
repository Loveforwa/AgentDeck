// electron-builder 配置（IS-36）：macOS 的 AgentDeck.app 和 .dmg，arm64、x64 各一个。
// 怎么打包、怎么发布见 apps/desktop/AGENTS.md「打包（IS-36）」。
//
// - 由 scripts/dist.mjs 调用（pnpm dist），projectDir 是 scripts/stage-app.mjs 准备的 .stage/app（只有 out/ 和两个原生模块），
//   不是本包：本包的 dependencies 是 workspace 的 TS 源码包，已经打进 out/。.stage/app 里有一份 package-lock.json，
//   electron-builder 按它认成 npm 项目、只收这两个模块；不然它会认出外面的 pnpm workspace，把整棵依赖树都收进 app.asar。
//   所以这里的路径都写成绝对路径。
// - 原生模块：better-sqlite3、node-pty 都是 N-API 预编译（DR-27），不重新编译（npmRebuild: false）；.node 和 spawn-helper
//   不能在 asar 里，整个模块 asarUnpack。node-pty 自己会把 app.asar 换成 app.asar.unpacked 去找 spawn-helper。
// - 随应用的文件放 Contents/Resources（process.resourcesPath）：tmux.conf、钩子脚本、pi / omp 扩展，路径见 src/main/paths.ts。
// - 没有 Apple 开发者证书：ad-hoc 签名（identity '-'），不公证。Apple 芯片上完全不签名的程序跑不起来，ad-hoc 至少能跑；
//   下载后第一次打开要右键 › 打开，或 xattr -dr com.apple.quarantine（见 AGENTS.md）。
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '../..');
const electronVersion = JSON.parse(readFileSync(join(__dirname, 'node_modules/electron/package.json'), 'utf8')).version;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.agentdeck.app',
  productName: 'AgentDeck',
  copyright: 'AgentDeck',
  electronVersion,
  directories: {
    output: join(__dirname, 'dist'),
    buildResources: join(__dirname, 'build-resources'),
  },
  // 原生模块都是 N-API 预编译，不按 Electron 的 ABI 重新编译
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  // 界面只有英文：Chromium 的语言包只留 en（右键菜单、拼写检查这些系统文字），每个架构小 40 MB 左右
  electronLanguages: ['en'],
  asar: true,
  asarUnpack: ['node_modules/better-sqlite3/**', 'node_modules/node-pty/**'],
  extraResources: [
    { from: join(root, 'packages/tmux-host/tmux.conf'), to: 'tmux.conf' },
    { from: join(root, 'tools/agentdeck-notify/bin/agentdeck-notify.mjs'), to: 'agentdeck-notify.mjs' },
    { from: join(root, 'tools/agentdeck-notify/bin/agentdeck-pi-extension.mjs'), to: 'agentdeck-pi-extension.mjs' },
    // CR15：agentdeck 命令（<数据目录>/bin/agentdeck 包装脚本运行它）
    { from: join(root, 'tools/agentdeck-cli/bin/agentdeck.mjs'), to: 'agentdeck.mjs' },
  ],
  afterPack: join(__dirname, 'scripts/after-pack.cjs'),
  mac: {
    // 目标和架构由 scripts/dist.mjs 传（默认 arm64、x64 两个 dmg）
    target: 'dmg',
    category: 'public.app-category.developer-tools',
    icon: join(__dirname, 'build-resources/icon.icns'),
    // ad-hoc 签名：没有开发者证书。hardened runtime 只在公证时需要，不开（开了要配 entitlements，node-pty 等还要 JIT 之类的权限）
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    darkModeSupport: true,
    minimumSystemVersion: '12.0',
    extendInfo: {
      // 「Open in Terminal」用 osascript 驱动 Terminal / iTerm（src/main/app-service.ts），系统第一次会问
      NSAppleEventsUsageDescription: 'AgentDeck opens a terminal in Terminal or iTerm when you ask it to.',
    },
  },
  dmg: {
    artifactName: 'AgentDeck-${version}-${arch}.${ext}',
    title: 'AgentDeck ${version}',
    // 不写 contents：用 electron-builder 默认的布局（左边应用、右边 Applications 的快捷方式）
  },
  publish: null,
};
