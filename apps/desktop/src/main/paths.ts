// 数据目录、运行目录、tmux 名字和随应用的文件在哪里。纯逻辑（不 import Electron），方便单测。
//
// - 数据目录：AGENTDECK_DATA_DIR 优先；开发时（没打包）默认仓库里被 git 忽略的 .agentdeck-dev/，不碰用户真实的 ~/.agentdeck；
//   打包后默认 ~/.agentdeck。
// - tmux 名字：AGENTDECK_TMUX_SOCKET 优先；开发时 agentdeck-desktop-dev，打包后 agentdeck（和 tmux-host 的 dev bridge 用的 agentdeck-dev 也分开）。
// - 运行目录（钩子 socket、终端输出 socket）：<数据目录>/run。Unix socket 路径最长 103 字节（macOS），
//   worktree 里的数据目录很长，放不下时改到 /tmp/agentdeck-<uid>-<数据目录的哈希>。

import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

export interface PathsInput {
  env: Record<string, string | undefined>;
  homeDir: string;
  /** 没打包（electron-vite dev 或直接用 electron 跑 out/）。 */
  isDev: boolean;
  /** 仓库根目录（开发时）；打包后为 null。 */
  repoRoot: string | null;
  /** 打包后的 resources 目录（process.resourcesPath）。 */
  resourcesPath: string | null;
  uid: number;
}

export interface AppPaths {
  dataDir: string;
  dbPath: string;
  settingsPath: string;
  runDir: string;
  hookSocket: string;
  tmuxSocketName: string;
  /** workspace-service 的 homeDir：worktree 放在 <它>/.agentdeck/worktrees/。 */
  worktreeHome: string;
  /** tmux.conf 的绝对路径。 */
  tmuxConf: string;
  /** agentdeck-notify.mjs 的绝对路径。 */
  notifyScript: string;
  /** agentdeck-pi-extension.mjs 的绝对路径：pi、omp 启动时用 -e 加载，把扩展事件转成钩子。 */
  agentExtension: string;
  /** CR15：agentdeck 命令（tools/agentdeck-cli 的 agentdeck.mjs）的绝对路径，<数据目录>/bin/agentdeck 包装脚本运行它。 */
  cliScript: string;
}

/** macOS 的 sockaddr_un.sun_path 是 104 字节（含结尾 0）。 */
export const MAX_SOCKET_PATH = 103;
/** 运行目录里最长的 socket 文件名：term-<tmux 名字>.sock（tmux-host）、hooks.sock。 */
function longestSocketFile(tmuxSocketName: string): number {
  return Math.max(`term-${tmuxSocketName}.sock`.length, 'hooks.sock'.length);
}

export function resolvePaths(input: PathsInput): AppPaths {
  const { env, homeDir, isDev, repoRoot } = input;
  const dataDir = resolve(
    env['AGENTDECK_DATA_DIR'] || (isDev && repoRoot ? join(repoRoot, '.agentdeck-dev') : join(homeDir, '.agentdeck')),
  );
  const tmuxSocketName = env['AGENTDECK_TMUX_SOCKET'] || (isDev ? 'agentdeck-desktop-dev' : 'agentdeck');
  let runDir = join(dataDir, 'run');
  if (runDir.length + 1 + longestSocketFile(tmuxSocketName) > MAX_SOCKET_PATH) {
    const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 10);
    runDir = `/tmp/agentdeck-${input.uid}-${hash}`;
  }
  // 数据目录就是 <home>/.agentdeck 时 worktree 照 workspace-service 的默认放；
  // 别的数据目录（开发、测试）放进数据目录里，免得往用户真实的 ~/.agentdeck/worktrees 里建东西。
  const worktreeHome = basename(dataDir) === '.agentdeck' ? dirname(dataDir) : join(dataDir, 'home');

  const root = repoRoot ?? '';
  const res = input.resourcesPath ?? '';
  return {
    dataDir,
    dbPath: join(dataDir, 'agentdeck.db'),
    settingsPath: join(dataDir, 'settings.json'),
    runDir,
    hookSocket: join(runDir, 'hooks.sock'),
    tmuxSocketName,
    worktreeHome,
    tmuxConf: repoRoot ? join(root, 'packages/tmux-host/tmux.conf') : join(res, 'tmux.conf'),
    notifyScript: repoRoot
      ? join(root, 'tools/agentdeck-notify/bin/agentdeck-notify.mjs')
      : join(res, 'agentdeck-notify.mjs'),
    agentExtension: repoRoot
      ? join(root, 'tools/agentdeck-notify/bin/agentdeck-pi-extension.mjs')
      : join(res, 'agentdeck-pi-extension.mjs'),
    cliScript: repoRoot ? join(root, 'tools/agentdeck-cli/bin/agentdeck.mjs') : join(res, 'agentdeck.mjs'),
  };
}
