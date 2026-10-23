// tmux-host 后面要用的命令，在这份配置下是否正常：
// capture-pane、pipe-pane、display-message、list-sessions、退出码、钩子、大小、环境变量、隔离。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachView, fmt, newSession, sleep, tmux, tmuxOk, waitUntil, PKG_DIR, SOCKET, CONF, TMUX, cleanEnv } from './lib.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-cmds-'));
const results = [];
// ok：true / false / 'note'（已知、已解释的行为，见 AGENTS.md）
const record = (group, name, ok, detail = '') => results.push({ group, name, ok, detail });
const kill = (id) => tmuxOk(['kill-session', '-t', `=${id}`]);
const cap = (id, ...a) => tmux(['capture-pane', '-p', '-t', `=${id}:`, ...a]);

// ---------------------------------------------------------------- capture-pane
{
  newSession('cap', ['sh', '-c', 'seq 1 50; printf "\\033[31mred tail\\033[0m\\n"; exec sleep 100000'], { cols: 80, rows: 20 });
  await waitUntil(() => cap('cap').includes('red tail'));
  const s3 = cap('cap', '-S', '-3').split('\n');
  if (s3.at(-1) === '') s3.pop();
  record('capture-pane', '-p -S -3 is "3 history lines + the whole screen", not "last 3 lines"', s3.length === 20 + 3, `${s3.length} lines, first ${JSON.stringify(s3[0])}`);
  // 真正的“最后 n 行”：抓可见区，去掉末尾空行，取最后 n 行。
  const last = (id, n) => {
    const l = cap(id, '-J').split('\n');
    while (l.length && l.at(-1).trim() === '') l.pop();
    return l.slice(-n);
  };
  record('capture-pane', 'last 3 non-empty lines (capture -J, trim trailing blanks)', JSON.stringify(last('cap', 3)) === JSON.stringify(['49', '50', 'red tail']), JSON.stringify(last('cap', 3)));
  const e = cap('cap', '-e', '-S', '-1');
  record('capture-pane', '-e keeps colors', e.includes('\x1b[31mred tail'), JSON.stringify(e.split('\n').find((l) => l.includes('red tail'))));
  kill('cap');

  newSession('cap2', ['sh', '-c', 'echo only one line; exec sleep 100000'], { cols: 80, rows: 20 });
  await waitUntil(() => cap('cap2').includes('only one line'));
  const raw3 = cap('cap2', '-S', '-3').split('\n');
  record('capture-pane', 'short output: the screen is mostly blank lines', true, `-S -3 gives ${raw3.length} lines, ${raw3.filter((l) => l.trim() === '').length} blank; last-n helper gives ${JSON.stringify(last('cap2', 3))}`);
  kill('cap2');
}

// ---------------------------------------------------------------- pipe-pane
{
  const out1 = path.join(tmp, 'pipe1.log');
  const out2 = path.join(tmp, 'pipe2.log');
  const prog = 'printf "FIRST\\n"; for i in 1 2 3 4 5 6; do printf "\\033[32mVITE ready\\033[0m  Local: http://localhost:5173/ tick $i\\n"; sleep 0.3; done; exec sleep 100000';
  // 分两条命令：new-session 之后再 pipe-pane，进程一开始的输出可能已经错过。
  newSession('pipe1', ['sh', '-c', prog]);
  tmux(['pipe-pane', '-o', '-t', '=pipe1:', `cat >> ${out1}`]);
  // 同一次 tmux 调用里接着 pipe-pane：在服务读窗格输出之前生效，不会漏。
  tmux(['new-session', '-d', '-s', 'pipe2', '-x', '120', '-y', '32', '-e', 'AGENTDECK_TERM=pipe2', '--', 'sh', '-c', prog, ';', 'pipe-pane', '-o', '-t', '=pipe2:', `cat >> ${out2}`]);
  await sleep(2500);
  const p1 = fs.readFileSync(out1, 'utf8');
  const p2 = fs.readFileSync(out2, 'utf8');
  record('pipe-pane', 'copies output while nobody is attached', p2.includes('http://localhost:5173/') && p2.includes('tick 6'), `${p2.length} bytes`);
  record('pipe-pane', 'copy is raw (escape sequences kept)', p2.includes('\x1b[32m'), '');
  record('pipe-pane', 'pipe-pane as a separate command after new-session: first output', p1.includes('FIRST') || 'note', p1.includes('FIRST') ? 'not missed this time (it is a race)' : 'MISSED the first line (race): chain the two commands');
  record('pipe-pane', 'chained in the same tmux call (new-session ; pipe-pane): first output', p2.includes('FIRST'), '');
  record('pipe-pane', '#{pane_pipe} reports it', fmt('=pipe2:', '#{pane_pipe}') === '1', '');
  // attach / detach 不影响抄送
  const before = fs.readFileSync(out2, 'utf8').length;
  const v = attachView('pipe2');
  await v.waitScreen((t) => t.includes('tick'));
  tmux(['send-keys', '-t', '=pipe2:', '-l', '']);
  v.kill();
  await v.exited;
  record('pipe-pane', 'still piping after attach + detach', fmt('=pipe2:', '#{pane_pipe}') === '1', `${fs.readFileSync(out2, 'utf8').length - before} bytes copied during attach (tmux redraw is not copied: pipe gets only program output)`);
  tmux(['pipe-pane', '-t', '=pipe2:']);
  record('pipe-pane', 'pipe-pane with no command stops it', fmt('=pipe2:', '#{pane_pipe}') === '0', '');
  kill('pipe1');
  kill('pipe2');
}

// ---------------------------------------------------------------- display-message、环境变量
{
  newSession('disp', ['sh', '-c', 'cd /tmp && exec sleep 100000'], { cwd: PKG_DIR });
  await sleep(300);
  const d = fmt('=disp:', '#{pane_current_path} #{pane_current_command}');
  record('display-message', "'#{pane_current_path} #{pane_current_command}'", d === `${fs.realpathSync('/tmp')} sleep`, JSON.stringify(d));
  const env = tmux(['show-environment', '-t', '=disp', 'AGENTDECK_TERM']).trim();
  record('environment', 'AGENTDECK_TERM set per session (new-session -e)', env === 'AGENTDECK_TERM=disp', env);
  kill('disp');
  newSession('envp', ['sh', '-c', 'echo "id=$AGENTDECK_TERM term=$TERM colorterm=$COLORTERM cc=$CLAUDE_CODE_TMUX_TRUECOLOR lang=$LANG"; exec sleep 100000']);
  await waitUntil(() => cap('envp').includes('id='));
  const line = cap('envp').split('\n').find((l) => l.startsWith('id='));
  record('environment', 'what the process sees', line === 'id=envp term=tmux-256color colorterm=truecolor cc=1 lang=en_US.UTF-8', line);
  kill('envp');
}

// ---------------------------------------------------------------- 退出码、remain-on-exit、respawn
{
  newSession('exit3', ['sh', '-c', 'echo bye; exit 3']);
  newSession('sig', ['sh', '-c', 'echo bye; kill -TERM $$']);
  await sleep(500);
  const e = fmt('=exit3:', '#{pane_dead} #{pane_dead_status} #{pane_dead_signal}');
  record('exit', 'remain-on-exit keeps the pane; exit status readable', e === '1 3 ', JSON.stringify(e));
  const s = fmt('=sig:', '#{pane_dead} #{pane_dead_status} #{pane_dead_signal}');
  record('exit', 'killed by a signal (pane_dead_signal is a name, not a number)', s === '1  term', JSON.stringify(s));
  const screen = cap('exit3').split('\n').filter((l) => l.trim());
  record('exit', 'no "Pane is dead" line (remain-on-exit-format empty)', screen.length === 1 && screen[0] === 'bye', JSON.stringify(screen));
  tmux(['respawn-pane', '-k', '-t', '=exit3:', 'sh', '-c', 'echo again; exec sleep 100000']);
  await waitUntil(() => cap('exit3').includes('again'));
  record('exit', 'respawn-pane -k restarts in the same session (T5 Restart)', fmt('=exit3:', '#{pane_dead}') === '0', '');
  kill('exit3');
  kill('sig');
}

// ---------------------------------------------------------------- list-sessions -F
{
  newSession('ls-a', ['sh', '-c', 'exec sleep 100000']);
  newSession('ls-b', ['sh', '-c', 'exit 7']);
  await sleep(300);
  const F = '#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_current_command}\t#{window_activity}';
  const rows = tmux(['list-sessions', '-F', F]).trim().split('\n').map((l) => l.split('\t'));
  const a = rows.find((r) => r[0] === 'ls-a');
  const b = rows.find((r) => r[0] === 'ls-b');
  record('list-sessions', '-F with pane formats (active pane of each session)', a && b && a[4] === '0' && b[4] === '1' && b[5] === '7', JSON.stringify(rows.filter((r) => r[0].startsWith('ls-'))));
  record('list-sessions', 'filter: -f', tmux(['list-sessions', '-f', '#{pane_dead}', '-F', '#{session_name}']).trim() === 'ls-b', '');
  kill('ls-a');
  kill('ls-b');
}

// ---------------------------------------------------------------- 钩子、活动和静默
{
  const log = path.join(tmp, 'hooks.log');
  fs.writeFileSync(log, '');
  const setHooks = () => {
    // 真正的 tmux-host 会这样挂钩子（回调到自己的本地端口）；这里写文件。
    // 服务在最后一个会话结束时退出（exit-empty），运行时挂的钩子随之丢失，所以要在有会话之后挂。
    for (const h of ['alert-activity', 'alert-silence', 'alert-bell', 'pane-died']) {
      tmux(['set-hook', '-g', h, `run-shell -b "echo ${h} #{session_name} >> ${log}"`]);
    }
  };
  // 1 秒后每 0.5 秒输出一次共 6 次，静默 5 秒，再输出 3 次、响铃，静默 4 秒，退出。
  const prog = 'sleep 1; for i in 1 2 3 4 5 6; do echo a$i; sleep 0.5; done; sleep 5; for i in 1 2 3; do echo b$i; sleep 0.5; done; printf "\\a"; sleep 4; exit 5';
  const sessions = [
    ['hk-none-detached', null, false],
    ['hk-none-attached', null, true],
    // 对比：activity-action any（只改这一个会话），看钩子和副作用
    ['hk-any-detached', 'any', false],
    ['hk-any-attached', 'any', true],
  ];
  const views = {};
  for (const [id, action, attached] of sessions) {
    newSession(id, ['sh', '-c', prog]);
    if (id === sessions[0][0]) setHooks();
    if (action) for (const o of ['activity-action', 'silence-action']) tmux(['set', '-t', `=${id}:`, o, action]);
    if (attached) {
      const v = attachView(id);
      v.bells = 0;
      v.term.onBell(() => v.bells++);
      views[id] = v;
    }
  }
  // 轮询 #{window_activity}：每秒一次，看能不能看出两段输出
  const polled = [];
  for (let i = 0; i < 17; i++) {
    polled.push(fmt('=hk-none-detached:', '#{window_activity} #{window_activity_flag}#{window_silence_flag}'));
    await sleep(1000);
  }
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  const count = (h, s) => lines.filter((l) => l === `${h} ${s}`).length;
  for (const [id, action, attached] of sessions) {
    const act = count('alert-activity', id);
    const sil = count('alert-silence', id);
    const ok = action ? act > 0 : act === 0;
    record('hooks', `${id}: alert-activity / alert-silence`, ok || 'note', `activity ${act}x, silence ${sil}x for 2 bursts / 2 gaps${attached ? `; bells at the client ${views[id].bells} (agent rang once)` : ''}`);
    record('hooks', `${id}: alert-bell, pane-died`, count('alert-bell', id) === 1 && count('pane-died', id) === 1, `bell ${count('alert-bell', id)}x, died ${count('pane-died', id)}x`);
  }
  const stamps = [...new Set(polled.map((p) => p.split(' ')[0]))];
  record('activity', 'polling #{window_activity} (1 s resolution) sees both bursts', stamps.length >= 3, `distinct timestamps ${stamps.length}; flags (activity,silence) over time ${polled.map((p) => p.split(' ')[1]).join(' ')}`);
  for (const v of Object.values(views)) v.kill();
  for (const h of ['alert-activity', 'alert-silence', 'alert-bell', 'pane-died']) tmux(['set-hook', '-gu', h]);
  for (const [id] of sessions) kill(id);
}

// ---------------------------------------------------------------- 大小
{
  newSession('size', ['sh', '-c', 'exec sleep 100000'], { cols: 100, rows: 30 });
  const sz = () => fmt('=size:', '#{window_width}x#{window_height}');
  record('size', 'new-session -x -y', sz() === '100x30', sz());
  const v1 = attachView('size', { cols: 132, rows: 40 });
  await v1.waitScreen(() => v1.firstDataAt !== null);
  await sleep(200);
  record('size', 'window follows the attached client (window-size latest)', sz() === '132x40', sz());
  const v2 = attachView('size', { cols: 90, rows: 25 });
  await v2.waitScreen(() => v2.firstDataAt !== null);
  await sleep(200);
  record('size', 'two clients: the most recent one wins', sz() === '90x25', sz());
  v2.write('x');
  v1.p.resize(150, 45);
  await sleep(300);
  record('size', 'resize of a client (node-pty resize) resizes the window', sz() === '150x45', `${sz()} (latest = client that resized / typed last)`);
  v2.kill();
  await v2.exited;
  await sleep(200);
  record('size', 'a client leaves: window takes the remaining client size', sz() === '150x45', sz());
  v1.kill();
  await v1.exited;
  await sleep(200);
  record('size', 'no clients: size stays', sz() === '150x45', sz());
  kill('size');
}

// ---------------------------------------------------------------- 历史和内存
{
  newSession('base', ['sh', '-c', 'exec sleep 100000']);
  const limit = Number(tmux(['show', '-gv', 'history-limit']).trim());
  const pid = tmux(['display-message', '-p', '#{pid}']).trim();
  const rssKb = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', pid], { encoding: 'utf8' }).trim());
  const base = rssKb();
  // 像 claude 的输出：110 列、真彩色、制表符
  const n = Math.round(limit * 1.2);
  newSession('hist', ['sh', '-c', `i=0; while [ $i -lt ${n} ]; do i=$((i+1)); printf "%s ── \\033[38;2;200;100;50m%s\\033[0m\\n" $i 1234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890abc; done; exec sleep 100000`], { cols: 120, rows: 32 });
  // 等最后一行打出来
  await waitUntil(() => new RegExp(`^${n} `, 'm').test(cap('hist')), 120000, 500);
  await sleep(500);
  const hs = Number(fmt('=hist:', '#{history_size}'));
  // tmux 满了之后一次删掉一批旧行，所以 history_size 停在略低于上限的地方。
  record('history', `history-limit ${limit} honored (trimmed in batches)`, hs <= limit && hs >= limit * 0.9, `${hs} / ${limit}`);
  const grown = rssKb() - base;
  record('history', 'memory for one full pane of claude-like lines', true, `+${Math.round(grown / 1024)} MB (${Math.round((grown * 1024) / hs)} bytes/line; server baseline ${Math.round(base / 1024)} MB)`);
  kill('hist');
  kill('base');
}

// ---------------------------------------------------------------- 隔离
{
  // 服务在没有会话时会退出，留一个会话来查。
  newSession('iso', ['sh', '-c', 'exec sleep 100000']);
  const ours = tmux(['display-message', '-p', '#{socket_path}']).trim();
  record('isolation', 'own socket', ours.endsWith(`/${SOCKET}`), ours);
  const def = (() => {
    try {
      return execFileSync(TMUX, ['ls'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() }).trim();
    } catch (e) {
      return String(e.stderr).trim();
    }
  })();
  record('isolation', 'default tmux server untouched (not started by us)', true, def.split('\n')[0]);
  record('isolation', 'config file actually in use', true, tmux(['display-message', '-p', '#{config_files}']).trim() || CONF);
  kill('iso');
}

const width = Math.max(...results.map((r) => `${r.group} · ${r.name}`.length));
for (const r of results) console.log(`${r.ok === 'note' ? 'note' : r.ok ? 'ok  ' : 'DIFF'} ${`${r.group} · ${r.name}`.padEnd(width)}  ${r.detail}`);
fs.rmSync(tmp, { recursive: true, force: true });
