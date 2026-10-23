// 量 attach 到首屏、detach 的时间（白板平移时终端反复接上、断开）。
//
// node timing.mjs [--session <已有会话>] [--marker <首屏里一定会出现的文字>] [--n 20] [--cols 120 --rows 32]
//
// 不给 --session 时自己起一个会话，打印 200 行带颜色的内容和一个标记。
// 每轮（每种 detach 方式各 n 轮）：
//   attach：spawn `tmux attach` 起算，到 pty 第一次有输出（firstByte）、
//           到 xterm 屏幕上出现标记（firstScreen）。
//   detach：前 n 轮用 `tmux detach-client`（服务端断开），后 n 轮直接结束 pty 进程（SIGHUP，
//           T2 移出视口时最可能的做法），量到 attach 进程退出、以及到 tmux 里看不到这个客户端。

import { attachView, fmt, newSession, stats, tmux, tmuxOk, waitUntil, sleep, PKG_DIR } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const n = Number(opt('n', 20));
const cols = Number(opt('cols', 120));
const rows = Number(opt('rows', 32));
let session = opt('session');
let marker = opt('marker');

if (!session) {
  session = 'timing';
  marker = 'TIMING-READY';
  tmuxOk(['kill-session', '-t', `=${session}`]);
  const script = `for i in $(seq 1 200); do printf '\\033[38;2;%d;120;40mline %d\\033[0m \\033[1mbold\\033[0m 中文\\n' $((i % 256)) $i; done; printf 'TIMING-READY\\n'; exec sleep 100000`;
  newSession(session, ['sh', '-c', script], { cwd: PKG_DIR, cols, rows });
  await waitUntil(() => tmux(['capture-pane', '-p', '-t', `=${session}:`]).includes(marker), 5000);
}
if (!marker) throw new Error('--marker is required with --session');

const clientsOf = () => tmuxOk(['list-clients', '-t', `=${session}`, '-F', '#{client_pid}']).out.trim().split('\n').filter(Boolean);

const firstByte = [];
const firstScreen = [];
const detachCmdExit = [];
const detachCmdGone = [];
const killExit = [];
const killGone = [];

// 每种 detach 方式各 n 轮，attach 的数据合起来算（共 2n 轮）。
for (let i = 0; i < 2 * n; i++) {
  const v = attachView(session, { cols, rows });
  const t0 = v.startedAt;
  const tScreen = await v.waitScreen((t) => t.includes(marker), 5000);
  firstByte.push(v.firstDataAt - t0);
  firstScreen.push(tScreen === null ? null : tScreen - t0);
  await sleep(50);

  const pid = String(v.p.pid);
  if (i < n) {
    // 服务端断开：detach-client 指定这个客户端的 tty。计时包含起一次 tmux 命令进程。
    const tty = tmux(['list-clients', '-t', `=${session}`, '-F', '#{client_pid} #{client_tty}']).split('\n').find((l) => l.startsWith(pid + ' '))?.split(' ')[1];
    const t1 = performance.now();
    tmux(['detach-client', '-t', tty]);
    await v.exited;
    detachCmdExit.push(v.exitedAt - t1);
    await waitUntil(() => !clientsOf().includes(pid), 2000, 2);
    detachCmdGone.push(performance.now() - t1);
  } else {
    const t1 = performance.now();
    v.kill('SIGHUP');
    await v.exited;
    killExit.push(v.exitedAt - t1);
    await waitUntil(() => !clientsOf().includes(pid), 2000, 2);
    killGone.push(performance.now() - t1);
  }
  await sleep(100);
}

const result = {
  session,
  size: `${cols}x${rows}`,
  paneCommand: fmt(`=${session}:`, '#{pane_current_command}'),
  historySize: Number(fmt(`=${session}:`, '#{history_size}')),
  attachFirstByteMs: stats(firstByte),
  attachFirstScreenMs: stats(firstScreen),
  detachClientCmd: { untilExitMs: stats(detachCmdExit), untilGoneMs: stats(detachCmdGone) },
  killPty: { untilExitMs: stats(killExit), untilGoneMs: stats(killGone) },
};
console.log(JSON.stringify(result, null, 2));
if (!opt('session')) tmuxOk(['kill-session', '-t', `=${session}`]);
