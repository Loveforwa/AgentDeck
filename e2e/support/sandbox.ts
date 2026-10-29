// 每个测试一个沙盒：临时目录里的数据目录、HOME、Electron 的 userData、假 agent、测试仓库，加一个专用的 tmux -L 名字。
// 结束时 kill 掉 tmux 服务、删掉所有临时目录。不碰用户自己的 ~/.claude*、~/.codex、~/.pi、~/.omp、~/.kimi-code、~/.agentdeck，
// 也不碰用户正在用的 AgentDeck（tmux 名字、数据目录、单实例锁都分开）。
//
// 环境怎么传进 AgentDeck：
// - Electron 进程本身拿到一份干净的最小环境（PATH、HOME、SHELL、AGENTDECK_*），不带 ELECTRON_*、CLAUDECODE 之类。
// - AgentDeck 启动时用 `$SHELL -ilc` 读登录 shell 环境（apps/desktop/src/main/login-env.ts），终端窗格和 agent 检测都用它。
//   这里 SHELL=/bin/bash、HOME 指到沙盒，沙盒里的 .bash_profile 把 PATH 设成「假 agent → 需要的系统命令 → /usr/bin:/bin」，
//   所以 AgentDeck 只认得假的 claude 和 Shell，真装着的 claude、codex、pi……都看不到。

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(E2E_DIR, '..');
export const DESKTOP_DIR = join(REPO_ROOT, 'apps/desktop');
const FAKE_CLAUDE = join(E2E_DIR, 'fake-agent/fake-claude.mjs');

/** 沙盒里能用的系统命令（在测试机的 PATH 里找，软链接进沙盒的 sysbin/）。 */
const SYSTEM_COMMANDS = ['tmux', 'git', 'node'];
const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export interface Sandbox {
  root: string;
  home: string;
  dataDir: string;
  userDataDir: string;
  /** 假 agent 写日志的目录（每个会话一个 .jsonl）。 */
  agentLogDir: string;
  /** 放测试仓库的目录。 */
  reposDir: string;
  tmuxSocket: string;
  /** 交给 Electron 的环境。 */
  env: Record<string, string>;
  /** 沙盒里的 PATH（git 等命令也用它跑）。 */
  path: string;
  /** 跑 tmux -L <沙盒的名字>。 */
  tmux(args: string[]): { status: number | null; stdout: string };
  dispose(): void;
}

function which(cmd: string): string {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  const path = r.stdout.trim();
  if (r.status !== 0 || !path) throw new Error(`e2e needs \`${cmd}\` on PATH`);
  return realpathSync(path);
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 和 apps/desktop/src/main/paths.ts 一样：socket 路径太长时运行目录挪到 /tmp/agentdeck-<uid>-<哈希>，清理时一起删。 */
function fallbackRunDir(dataDir: string): string {
  const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 10);
  return `/tmp/agentdeck-${process.getuid?.() ?? 0}-${hash}`;
}

/** 沙盒默认挡住的真 agent（claude 本来就换成了假的）。 */
export const SHIELDED_AGENTS = ['codex', 'pi', 'omp', 'kimi'] as const;

export function createSandbox(name: string): Sandbox {
  // realpath：macOS 的 tmpdir 在 /var 下，git 报的是 /private/var，比较路径时要一致
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-e2e-')));
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const userDataDir = join(root, 'electron');
  const agentLogDir = join(root, 'agent-log');
  const reposDir = join(root, 'repos');
  const fakeBin = join(root, 'fakebin');
  const sysBin = join(root, 'sysbin');
  for (const d of [home, dataDir, userDataDir, agentLogDir, reposDir, fakeBin, sysBin]) mkdirSync(d, { recursive: true });

  const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 16);
  const tmuxSocket = `agentdeck-e2e-${slug}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  // 系统命令：只链接需要的几个，不把 /opt/homebrew/bin 整个放进 PATH（那里可能装着真的 codex、pi……）
  for (const cmd of SYSTEM_COMMANDS) symlinkSync(which(cmd), join(sysBin, cmd));
  // 假 claude：用跑测试的这个 node 执行
  const claude = join(fakeBin, 'claude');
  writeFileSync(claude, `#!/bin/sh\nexec ${q(process.execPath)} ${q(FAKE_CLAUDE)} "$@"\n`);
  chmodSync(claude, 0o755);
  // AgentDeck 读登录环境后会在 PATH 末尾补 /opt/homebrew/bin 等目录（login-env.ts 的 withCommonPaths），本机装着的真 codex、pi、omp、kimi
  // 会被检测到、甚至被运行。fakebin 在 PATH 最前面，放同名的桩挡住（exit 127 = 没装）；要用假程序的测试会覆盖它们（installFake）。
  for (const name of SHIELDED_AGENTS) {
    const file = join(fakeBin, name);
    writeFileSync(file, '#!/bin/sh\n# AgentDeck e2e：挡住真装着的同名程序\nexit 127\n');
    chmodSync(file, 0o755);
  }

  const path = `${fakeBin}:${sysBin}:${BASE_PATH}`;
  // 登录 shell 的配置：AgentDeck 读环境、终端里的 Shell 都会读它
  const profile = [
    '# AgentDeck e2e 沙盒（自动生成）',
    `export PATH=${q(path)}`,
    `export AGENTDECK_E2E_LOG_DIR=${q(agentLogDir)}`,
    'export BASH_SILENCE_DEPRECATION_WARNING=1',
    'export LANG=en_US.UTF-8',
    "export PS1='e2e$ '",
    'export HISTFILE=/dev/null',
    '',
  ].join('\n');
  writeFileSync(join(home, '.bash_profile'), profile);
  writeFileSync(join(home, '.profile'), profile);
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = AgentDeck E2E\n\temail = e2e@agentdeck.invalid\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n',
  );
  // 设置：不发系统通知（测试会让窗口失去焦点），编辑器命令换成什么也不做的 true
  writeFileSync(
    join(dataDir, 'settings.json'),
    `${JSON.stringify({ notifications: false, editorCommand: 'true', closeWindow: 'background' }, null, 2)}\n`,
  );

  const env: Record<string, string> = {
    PATH: path,
    HOME: home,
    SHELL: '/bin/bash',
    USER: process.env['USER'] ?? 'e2e',
    LOGNAME: process.env['LOGNAME'] ?? process.env['USER'] ?? 'e2e',
    TMPDIR: process.env['TMPDIR'] ?? '/tmp',
    LANG: 'en_US.UTF-8',
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    AGENTDECK_DATA_DIR: dataDir,
    AGENTDECK_TMUX_SOCKET: tmuxSocket,
    AGENTDECK_E2E_LOG_DIR: agentLogDir,
    // 窗口固定 1440×900，CI 的小屏幕（1024×768）也一样大，白板上的位置和本机一致；AGENTDECK_E2E_WINDOW_SIZE 可以改（例如 1024x677 复现 CI）
    AGENTDECK_WINDOW_SIZE: process.env['AGENTDECK_E2E_WINDOW_SIZE'] ?? '1440x900',
    // 窗口不抢焦点、不跳到最前面：跑 e2e 时可以照常用电脑（测试里的焦点由各自的桩决定，不靠真焦点）
    AGENTDECK_BACKGROUND: '1',
  };
  // Linux（CI 里的 xvfb-run）要 DISPLAY；有 Wayland 也照传
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }

  const tmuxPath = join(sysBin, 'tmux');
  const tmux = (args: string[]) => {
    const r = spawnSync(tmuxPath, ['-L', tmuxSocket, ...args], { encoding: 'utf8', env: { ...env, TMUX: '' } });
    return { status: r.status, stdout: r.stdout ?? '' };
  };

  return {
    root,
    home,
    dataDir,
    userDataDir,
    agentLogDir,
    reposDir,
    tmuxSocket,
    env,
    path,
    tmux,
    dispose() {
      tmux(['kill-server']);
      // kill-server 之后 socket 文件有时还留着（tmux-<uid>/<名字>），一起删
      rmSync(join(process.env['TMUX_TMPDIR'] || '/tmp', `tmux-${process.getuid?.() ?? 0}`, tmuxSocket), { force: true });
      const runDir = fallbackRunDir(dataDir);
      if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 在沙盒环境里跑 git（HOME 是沙盒的，用沙盒的 .gitconfig）。 */
export function git(sb: Sandbox, cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...sb.env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' }).trim();
}
