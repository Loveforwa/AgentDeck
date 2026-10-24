// TerminalHost 的真实实现：所有进程跑在 AgentDeck 自己的 tmux 实例里（tmux -L agentdeck -f tmux.conf）。
// 行为对照 packages/contracts/src/terminal.ts 的注释；为什么这样做见 AGENTS.md（F7 的试验结论和问题编号）。
//
//   create  → 一次 tmux 调用里 new-session + set-hook pane-died + pipe-pane（问题 7、8）
//   输出流  → pipe-pane 经 nc 抄到 stream.ts 的 socket：算 activity / silence（问题 6）、找链接（port-watch，由组装注入）
//   显示    → attach 时用 node-pty 跑 `tmux -u -T … attach-session`（问题 4），pty 的输出就是 TerminalDataMessage
//   退出    → pane-died 钩子经同一个 socket 报回来；另有每 2 秒一次的 list-sessions 兜底，顺便发现服务没了（host-lost）

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDeckError, TERMINAL_ID_ENV } from '@agentdeck/contracts';
import type {
  CreateTerminalRequest,
  TermSize,
  TerminalDataMessage,
  TerminalEvent,
  TerminalHost,
  TerminalId,
  TerminalInfo,
  TerminalLink,
  ViewId,
} from '@agentdeck/contracts';
import { findExecutable, isDirectory, paneEnv, readEnv, serverEnv, type Env, type EnvSource } from './env.ts';
import { classifyInput } from './input.ts';
import { loadNodePty, type IPty, type PtyModule } from './pty.ts';
import { exitCodeOf, KILLED_EXIT_CODE } from './signals.ts';
import { startStreamServer, type StreamServer } from './stream.ts';
import { checkTmux, CLIENT_FEATURES, createRunner, shQuote, TmuxError, tmuxFormatEscape, type TmuxRunner } from './tmux.ts';

/** 从输出流里找链接的东西，由组装传 port-watch 的 createLinkWatcher 进来（服务包之间不能直接 import）。 */
export interface LinkWatcher {
  /** 喂一段原始输出（含转义序列），返回这段里新完成的链接。 */
  push(data: string): TerminalLink[];
  /** 把还没换行的最后一段也算上（输出停下来时调用）。 */
  flush?(): TerminalLink[];
  /** 窗格宽度，用来把程序按宽度折断的长地址接回去。 */
  setWidth?(cols: number): void;
}

export interface TmuxHostOptions {
  /** 登录 shell 的环境（apps/desktop 启动时读一次，见 docs/decisions.md）。窗格和 tmux 服务都从它派生，不用当前进程的环境。 */
  env: EnvSource;
  /** TerminalEvent。组装时转给主进程的事件总线。 */
  onEvent(event: TerminalEvent): void;
  /** 终端输出。组装时按 viewId 写进对应窗口的 MessagePort（contracts ipc.ts 线路约定 3）。 */
  onData(message: TerminalDataMessage): void;
  /** tmux -L 的名字，默认 'agentdeck'。测试用自己的名字，互不影响。 */
  socketName?: string;
  /** tmux.conf 的绝对路径。默认是本包里的那份；打包后要指向 resources 里的副本。 */
  configPath?: string;
  /** tmux 可执行文件。默认在 env.PATH 里找，再试 /opt/homebrew/bin、/usr/local/bin。 */
  tmuxPath?: string;
  /** 放抄送 socket 的目录，默认 ~/.agentdeck/run。路径要短（Unix socket 最长 103 字节）。 */
  runDir?: string;
  /** nc（macOS 自带 /usr/bin/nc，要支持 -U）。 */
  ncPath?: string;
  /** 多久没有输出发 terminal.silence，默认 3000。 */
  silenceMs?: number;
  /** list-sessions 兜底检查的间隔，默认 2000。 */
  healthIntervalMs?: number;
  /** 每个终端一个链接识别器。不给就不发 terminal.link。 */
  linkWatcher?: () => LinkWatcher;
  /** 测试替换 node-pty。 */
  pty?: PtyModule;
}

export interface TmuxHost extends TerminalHost {
  readonly tmuxVersion: string;
  readonly socketName: string;
  /** 停掉 socket、断开所有显示连接、停计时器。tmux 里的会话不受影响（应用退出后 agent 继续跑）。 */
  dispose(): Promise<void>;
  /** 结束整个 tmux 服务（Stop all and quit、测试清理）。不发事件。 */
  killServer(): Promise<void>;
}

/** 本包里的 tmux.conf。 */
export const DEFAULT_TMUX_CONF = fileURLToPath(new URL('../tmux.conf', import.meta.url));

const DEFAULT_SIZE: TermSize = { cols: 120, rows: 32 };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INPUT_EVENT_GAP_MS = 250;
const RECENT_LINKS = 20;
/** T6 重开应用后第一次要 recentLinks 时，从 tmux 历史里补找多少行。 */
const HISTORY_LINK_LINES = 500;

interface Entry {
  id: TerminalId;
  cwd: string;
  alive: boolean;
  exitCode: number | null;
  /** 正在被 kill()，之后来的 pane-died 不再发 exit。 */
  killing: boolean;
  addedAt: number;
  lastActivityAt: number | null;
  /** 一段连续输出里只发一次 activity，停下 silenceMs 后发 silence。 */
  active: boolean;
  /** 上次 silence 之后有过输出或输入，静默计时器到点时才发 silence。 */
  pendingSilence: boolean;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  lastInputEventAt: number;
  cols: number;
  watcher: LinkWatcher | null;
  links: TerminalLink[];
  linkKeys: Set<string>;
  /** recentLinks 是否已经从 tmux 历史里补过（重开应用接回的会话，之前的输出没经过 watcher）。 */
  historyScanned: boolean;
}

interface View {
  id: ViewId;
  terminalId: TerminalId;
  pty: IPty;
  /** 收到 tmux 的第一段输出之后才写入用户输入（问题 2）。 */
  ready: boolean;
  /** 等待写入的输入，保持顺序。 */
  queue: string[];
  /** 正在执行“先退出回滚”。 */
  busy: boolean;
  /** 发过鼠标事件，tmux 可能进了回滚（滚轮上、拖动选中）。 */
  maybeInMode: boolean;
  closed: boolean;
}

export async function startTmuxHost(options: TmuxHostOptions): Promise<TmuxHost> {
  const login = readEnv(options.env);
  const env = serverEnv(login);
  const tmuxPath = options.tmuxPath ?? findTmux(login);
  const version = await checkTmux(tmuxPath, env);
  const ncPath = options.ncPath ?? findExecutable('nc', { PATH: `/usr/bin:${login.PATH ?? ''}` });
  if (!ncPath) {
    throw new AgentDeckError({ code: 'tmux-unavailable', message: 'nc was not found.', detail: 'AgentDeck uses /usr/bin/nc (with -U) to read terminal output.' });
  }
  const socketName = options.socketName ?? 'agentdeck';
  const runner = createRunner({ path: tmuxPath!, socket: socketName, config: options.configPath ?? DEFAULT_TMUX_CONF, env });
  const runDir = options.runDir ?? join(login.HOME ?? homedir(), '.agentdeck', 'run');
  const host = new TmuxHostImpl(options, runner, version.raw, ncPath, join(runDir, `term-${socketName}.sock`));
  await host.start();
  return host;
}

function findTmux(env: Env): string | null {
  return findExecutable('tmux', { PATH: `${env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin` });
}

class TmuxHostImpl implements TmuxHost {
  readonly socketName: string;
  private stream: StreamServer | null = null;
  private readonly entries = new Map<TerminalId, Entry>();
  private readonly views = new Map<ViewId, View>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthSoon: ReturnType<typeof setTimeout> | null = null;
  private healthRunning = false;
  private disposed = false;
  private stopping = false;
  private viewCounter = 0;
  private readonly silenceMs: number;
  private readonly pty: PtyModule;
  private readonly opts: TmuxHostOptions;
  private readonly tmux: TmuxRunner;
  readonly tmuxVersion: string;
  private readonly ncPath: string;
  private readonly socketPath: string;

  // 不用参数属性：这样 node 自带的去类型（node dev/bridge.ts）也能直接跑
  constructor(opts: TmuxHostOptions, tmux: TmuxRunner, tmuxVersion: string, ncPath: string, socketPath: string) {
    this.opts = opts;
    this.tmux = tmux;
    this.tmuxVersion = tmuxVersion;
    this.ncPath = ncPath;
    this.socketPath = socketPath;
    this.socketName = tmux.socket;
    this.silenceMs = opts.silenceMs ?? 3000;
    this.pty = opts.pty ?? loadNodePty();
  }

  async start(): Promise<void> {
    this.stream = await startStreamServer(this.socketPath, {
      onPipeData: (id, data) => this.onOutput(id, data),
      onPipeEnd: () => this.checkHealthSoon(),
      onExit: (id, status, signal) => this.onPaneDied(id, exitCodeOf(status, signal)),
    });
    await this.adopt();
    this.healthTimer = setInterval(() => void this.checkHealth(), this.opts.healthIntervalMs ?? 2000);
    this.healthTimer.unref?.();
  }

  // ---- TerminalHost ----

  async create(req: CreateTerminalRequest): Promise<{ id: TerminalId }> {
    const id = req.id ?? newTerminalId();
    if (!ID_RE.test(id)) throw new AgentDeckError({ code: 'invalid-argument', message: `Invalid terminal id: ${id}` });
    if (this.entries.has(id)) throw new AgentDeckError({ code: 'invalid-argument', message: `Terminal ${id} already exists` });
    if (!isDirectory(req.cwd)) throw new AgentDeckError({ code: 'invalid-argument', message: `Folder not found: ${req.cwd}` });

    const login = readEnv(this.opts.env);
    const env: Env = { ...paneEnv(login), ...req.env, [TERMINAL_ID_ENV]: id };
    const exe = findExecutable(req.cmd, env, req.cwd);
    if (!exe) throw new AgentDeckError({ code: 'command-not-found', message: `Command not found: ${req.cmd}` });
    const size = req.size ?? DEFAULT_SIZE;
    const target = `=${id}:`;
    // 只有一个参数时 tmux 会交给 default-shell -c 去跑；经 /usr/bin/env 直接 exec，不经 shell（F7 的做法）。
    const argv = req.args.length > 0 ? [exe, ...req.args] : ['/usr/bin/env', exe];
    const entry = this.newEntry(id, req.cwd, size.cols);
    this.entries.set(id, entry);
    try {
      await this.tmux.run([
        'new-session', '-d', '-s', id, '-x', String(size.cols), '-y', String(size.rows), '-c', req.cwd,
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        '--', ...argv,
        ';', ...this.hookArgs(),
        // 和 new-session 在同一次调用里，开头的输出才不会漏（问题 8）
        ';', 'pipe-pane', '-t', target, this.pipeCommand(id),
      ]);
    } catch (e) {
      this.entries.delete(id);
      if (e instanceof TmuxError && e.duplicateSession) {
        throw new AgentDeckError({ code: 'invalid-argument', message: `Terminal ${id} already exists` });
      }
      throw toAgentDeckError(e, 'Could not start the terminal');
    }
    return { id };
  }

  async kill(id: TerminalId): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) entry.killing = true;
    let dead: boolean;
    try {
      const out = await this.tmux.run(['display-message', '-p', '-t', `=${id}:`, '#{pane_dead}', ';', 'kill-session', '-t', `=${id}`]);
      dead = out.trim() === '1';
    } catch (e) {
      if (entry) entry.killing = false;
      if (e instanceof TmuxError && (e.sessionMissing || e.noServer)) {
        if (!entry) throw new AgentDeckError({ code: 'not-found', message: `Terminal ${id} not found` });
        // 会话已经不在了（例如用户在系统终端里结束了它）
        this.removeEntry(entry);
        if (entry.alive) this.emit({ type: 'terminal.exit', id, code: KILLED_EXIT_CODE });
        return;
      }
      throw toAgentDeckError(e, 'Could not stop the terminal');
    }
    for (const v of [...this.views.values()]) if (v.terminalId === id) this.closeView(v);
    const wasAlive = entry ? entry.alive && !dead : !dead;
    if (entry) this.removeEntry(entry);
    if (wasAlive) this.emit({ type: 'terminal.exit', id, code: KILLED_EXIT_CODE });
  }

  async list(): Promise<TerminalInfo[]> {
    const rows = await this.listSessions();
    if (rows === null) return [];
    return rows.map((r) => {
      const entry = this.entries.get(r.id);
      const activity = entry?.lastActivityAt ?? (r.activity > 0 ? r.activity * 1000 : null);
      return {
        id: r.id,
        cwd: r.cwd,
        command: r.command,
        alive: !r.dead,
        exitCode: r.dead ? r.exitCode : null,
        lastActivityAt: activity === null ? null : new Date(activity).toISOString(),
        title: r.title,
      };
    });
  }

  async attach(id: TerminalId, size: TermSize): Promise<{ viewId: ViewId }> {
    let entry = this.entries.get(id);
    if (!entry) {
      // 不是这次启动时接回的（例如别人在系统终端里新建的），先确认会话在
      await this.tmux.run(['has-session', '-t', `=${id}`]).catch((e: unknown) => {
        if (e instanceof TmuxError && (e.sessionMissing || e.noServer)) throw new AgentDeckError({ code: 'not-found', message: `Terminal ${id} not found` });
        throw toAgentDeckError(e, 'Could not attach');
      });
      await this.adopt();
      entry = this.entries.get(id);
    }
    if (entry) {
      entry.cols = size.cols;
      entry.watcher?.setWidth?.(size.cols);
    }
    const viewId = `v-${(++this.viewCounter).toString(36)}-${randomBytes(3).toString('hex')}` as ViewId;
    const p = this.pty.spawn(this.tmux.path, this.tmux.argv(['-u', '-T', CLIENT_FEATURES, 'attach-session', '-t', `=${id}`]), {
      name: 'xterm-256color',
      cols: Math.max(1, size.cols),
      rows: Math.max(1, size.rows),
      cwd: this.tmux.env.HOME ?? homedir(),
      env: { ...this.tmux.env, TERM: 'xterm-256color' },
    });
    const view: View = { id: viewId, terminalId: id, pty: p, ready: false, queue: [], busy: false, maybeInMode: false, closed: false };
    this.views.set(viewId, view);
    p.onData((data) => {
      if (view.closed) return;
      this.opts.onData({ viewId, data });
      if (!view.ready) {
        view.ready = true;
        this.flush(view);
      }
    });
    p.onExit(() => {
      view.closed = true;
      this.views.delete(viewId);
    });
    return { viewId };
  }

  async detach(viewId: ViewId): Promise<void> {
    const v = this.views.get(viewId);
    if (v) this.closeView(v);
  }

  write(viewId: ViewId, data: string): void {
    const v = this.views.get(viewId);
    if (!v || v.closed || data === '') return;
    if (classifyInput(data).user) this.noteInput(v.terminalId);
    v.queue.push(data);
    this.flush(v);
  }

  resize(viewId: ViewId, size: TermSize): void {
    const v = this.views.get(viewId);
    if (!v || v.closed) return;
    try {
      v.pty.resize(Math.max(1, size.cols), Math.max(1, size.rows));
    } catch {
      // pty 刚好关了
    }
    const entry = this.entries.get(v.terminalId);
    if (entry) {
      entry.cols = size.cols;
      entry.watcher?.setWidth?.(size.cols);
    }
  }

  async sendKeys(id: TerminalId, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const t = `=${id}:`;
    try {
      // 窗格在回滚里时按键会被 copy-mode 的键表吃掉，先退出回滚（问题 9）
      await this.tmux.run(['if-shell', '-F', '-t', t, '#{pane_in_mode}', `send-keys -t ${t} -X cancel`, ';', 'send-keys', '-t', t, '--', ...keys]);
    } catch (e) {
      if (e instanceof TmuxError && (e.sessionMissing || e.noServer)) throw new AgentDeckError({ code: 'not-found', message: `Terminal ${id} not found` });
      throw toAgentDeckError(e, 'Could not send keys');
    }
    this.noteInput(id);
  }

  async lastLines(id: TerminalId, n: number): Promise<string[]> {
    if (n <= 0) return [];
    const lines = await this.capture(id, null);
    return lines.slice(-n);
  }

  async attachCommand(id: TerminalId): Promise<string> {
    // 给系统终端用：只带 -u（问题 4，-T 会让 Terminal.app 颜色错）
    return [this.tmux.path, '-L', this.tmux.socket, '-f', this.tmux.config, '-u', 'attach-session', '-t', `=${id}`].map(shQuote).join(' ');
  }

  async recentLinks(id: TerminalId): Promise<TerminalLink[]> {
    const entry = this.entries.get(id);
    if (!entry) {
      await this.capture(id, 1); // 不存在时抛 not-found
      return [];
    }
    if (!entry.historyScanned && this.opts.linkWatcher) {
      entry.historyScanned = true;
      // 重开应用接回的会话：之前的输出没经过 watcher，从 tmux 历史里补一遍（不发事件）
      const watcher = this.opts.linkWatcher();
      watcher.setWidth?.(entry.cols);
      const lines = await this.capture(id, HISTORY_LINK_LINES).catch(() => [] as string[]);
      const found = [...watcher.push(lines.join('\r\n') + '\r\n'), ...(watcher.flush?.() ?? [])];
      // found 是从旧到新；历史里的都比接回后新出现的旧，新的在前排到后面
      for (const link of found.reverse()) this.rememberLink(entry, link, { emit: false, front: false });
    }
    return entry.links.map((l) => ({ ...l }));
  }

  // ---- 额外的 ----

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.healthSoon) clearTimeout(this.healthSoon);
    for (const v of [...this.views.values()]) this.closeView(v);
    for (const e of this.entries.values()) this.clearSilence(e);
    await this.stream?.close();
  }

  async killServer(): Promise<void> {
    this.stopping = true;
    for (const v of [...this.views.values()]) this.closeView(v);
    for (const e of this.entries.values()) this.clearSilence(e);
    this.entries.clear();
    await this.tmux.run(['kill-server']).catch(() => {});
    this.stopping = false;
  }

  // ---- 内部 ----

  private emit(event: TerminalEvent): void {
    if (!this.disposed) this.opts.onEvent(event);
  }

  private newEntry(id: TerminalId, cwd: string, cols: number): Entry {
    const watcher = this.opts.linkWatcher?.() ?? null;
    watcher?.setWidth?.(cols);
    return {
      id,
      cwd,
      alive: true,
      exitCode: null,
      killing: false,
      addedAt: Date.now(),
      lastActivityAt: null,
      active: false,
      pendingSilence: false,
      silenceTimer: null,
      lastInputEventAt: 0,
      cols,
      watcher,
      links: [],
      linkKeys: new Set(),
      historyScanned: true,
    };
  }

  private removeEntry(entry: Entry): void {
    this.clearSilence(entry);
    this.entries.delete(entry.id);
  }

  /** pane-died 钩子：`run-shell -b` 把一行 “exit <id> <status> <signal>” 发回 socket。 */
  private hookArgs(): string[] {
    const sock = tmuxFormatEscape(shQuote(this.socketPath));
    const nc = tmuxFormatEscape(shQuote(this.ncPath));
    return ['set-hook', '-g', 'pane-died', `run-shell -b "echo 'exit #{session_name} #{pane_dead_status} #{pane_dead_signal}' | ${nc} -U ${sock}"`];
  }

  /** pipe-pane 的命令。会经过 tmux 的格式展开和 strftime，不能出现未转义的 # 和 %（实测 %s 变成时间戳）。 */
  private pipeCommand(id: TerminalId): string {
    const sock = tmuxFormatEscape(shQuote(this.socketPath));
    const nc = tmuxFormatEscape(shQuote(this.ncPath));
    return `{ echo 'pipe ${id}'; exec cat; } | exec ${nc} -U ${sock}`;
  }

  /**
   * 接回已经在跑的会话（T6：⌘Q 后再打开；或者这次启动前就有的会话）。
   * 重新挂钩子、重新接 pipe-pane（上次的 nc 在 AgentDeck 退出时已经断了）。
   */
  private async adopt(): Promise<void> {
    const rows = await this.listSessions();
    if (rows === null) return;
    const fresh = rows.filter((r) => !this.entries.has(r.id));
    if (fresh.length === 0) return;
    const args: string[] = [...this.hookArgs()];
    for (const r of fresh) {
      const entry = this.newEntry(r.id, r.cwd, r.width || DEFAULT_SIZE.cols);
      entry.alive = !r.dead;
      entry.exitCode = r.dead ? r.exitCode : null;
      entry.lastActivityAt = r.activity > 0 ? r.activity * 1000 : null;
      entry.historyScanned = false;
      this.entries.set(r.id, entry);
      // 不带 -o：已经有 pipe 时替换掉
      if (!r.dead) args.push(';', 'pipe-pane', '-t', `=${r.id}:`, this.pipeCommand(r.id));
    }
    await this.tmux.run(args).catch(() => {});
  }

  private async listSessions(): Promise<SessionRow[] | null> {
    try {
      const out = await this.tmux.run(['list-sessions', '-F', SESSION_FORMAT]);
      return parseSessions(out);
    } catch (e) {
      if (e instanceof TmuxError && e.noServer) return null;
      throw toAgentDeckError(e, 'Could not list terminals');
    }
  }

  /** capture-pane：去掉末尾空行。history 为 null 时只要可见屏幕，否则再往前取这么多行。 */
  private async capture(id: TerminalId, history: number | null): Promise<string[]> {
    const args = ['capture-pane', '-p', '-J', '-t', `=${id}:`];
    if (history !== null) args.push('-S', String(-history));
    let out: string;
    try {
      out = await this.tmux.run(args);
    } catch (e) {
      if (e instanceof TmuxError && (e.sessionMissing || e.noServer)) throw new AgentDeckError({ code: 'not-found', message: `Terminal ${id} not found` });
      throw toAgentDeckError(e, 'Could not read the terminal');
    }
    const lines = out.split('\n').map((l) => l.replace(/\s+$/, ''));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  private onOutput(id: TerminalId, data: string): void {
    const entry = this.entries.get(id);
    if (!entry || this.disposed) return;
    const now = Date.now();
    entry.lastActivityAt = now;
    if (!entry.active) {
      entry.active = true;
      this.emit({ type: 'terminal.activity', id, at: new Date(now).toISOString() });
    }
    this.armSilence(entry);
    if (entry.watcher) for (const link of entry.watcher.push(data)) this.rememberLink(entry, link, { emit: true, front: true });
  }

  private rememberLink(entry: Entry, link: TerminalLink, o: { emit: boolean; front: boolean }): void {
    const key = linkKey(link);
    if (entry.linkKeys.has(key)) {
      if (!o.front) return;
      // 又出现一次：挪到最前面，不再发事件
      const i = entry.links.findIndex((l) => linkKey(l) === key);
      if (i > 0) entry.links.unshift(...entry.links.splice(i, 1));
      return;
    }
    entry.linkKeys.add(key);
    if (o.front) entry.links.unshift(link);
    else entry.links.push(link);
    while (entry.links.length > RECENT_LINKS) {
      const dropped = entry.links.pop(); // 新的在前，去掉最旧的
      if (dropped) entry.linkKeys.delete(linkKey(dropped));
    }
    if (o.emit) this.emit({ type: 'terminal.link', id: entry.id, link });
  }

  /** 3 秒没有输出（也没有输入）发 silence。输入也重新计时：用户按了 Esc 但程序什么都没输出时，状态机也要能等到 silence（docs/decisions.md 的兜底规则）。 */
  private armSilence(entry: Entry): void {
    entry.pendingSilence = true;
    if (entry.silenceTimer) clearTimeout(entry.silenceTimer);
    if (this.silenceMs <= 0) return;
    entry.silenceTimer = setTimeout(() => {
      entry.silenceTimer = null;
      if (entry.watcher?.flush) for (const link of entry.watcher.flush()) this.rememberLink(entry, link, { emit: true, front: true });
      if (!entry.pendingSilence || !entry.alive) return;
      entry.pendingSilence = false;
      entry.active = false;
      this.emit({ type: 'terminal.silence', id: entry.id, at: new Date().toISOString() });
    }, this.silenceMs);
    entry.silenceTimer.unref?.();
  }

  private clearSilence(entry: Entry): void {
    if (entry.silenceTimer) clearTimeout(entry.silenceTimer);
    entry.silenceTimer = null;
    entry.pendingSilence = false;
    entry.active = false;
  }

  private noteInput(id: TerminalId): void {
    const entry = this.entries.get(id);
    const now = Date.now();
    if (entry) {
      if (entry.alive) this.armSilence(entry);
      if (now - entry.lastInputEventAt < INPUT_EVENT_GAP_MS) return;
      entry.lastInputEventAt = now;
    }
    this.emit({ type: 'terminal.input', id, at: new Date(now).toISOString() });
  }

  private onPaneDied(id: TerminalId, code: number | null): void {
    const entry = this.entries.get(id);
    if (!entry || !entry.alive || entry.killing) return;
    entry.alive = false;
    entry.exitCode = code ?? 0;
    this.clearSilence(entry);
    if (entry.watcher?.flush) for (const link of entry.watcher.flush()) this.rememberLink(entry, link, { emit: true, front: true });
    this.emit({ type: 'terminal.exit', id, code: entry.exitCode });
  }

  /** 按顺序把输入写进 pty。还没收到首屏、或者正在退出回滚时先排队。 */
  private flush(v: View): void {
    while (!v.closed && v.ready && !v.busy && v.queue.length > 0) {
      const data = v.queue[0]!;
      const kind = classifyInput(data);
      if (kind.mouse) v.maybeInMode = true;
      if (kind.keys && v.maybeInMode) {
        // 用户滚轮翻上去或拖选过，tmux 可能在回滚里：先退出回滚再写，不然这个键会被 copy-mode 的 Any 吞掉（问题 9）
        v.maybeInMode = false;
        v.busy = true;
        const t = `=${v.terminalId}:`;
        void this.tmux
          .run(['if-shell', '-F', '-t', t, '#{pane_in_mode}', `send-keys -t ${t} -X cancel`])
          .catch(() => {})
          .finally(() => {
            v.busy = false;
            if (v.queue[0] === data) {
              v.queue.shift();
              this.writePty(v, data);
            }
            this.flush(v);
          });
        return;
      }
      v.queue.shift();
      this.writePty(v, data);
    }
  }

  private writePty(v: View, data: string): void {
    if (v.closed) return;
    try {
      v.pty.write(data);
    } catch {
      // pty 已经关了
    }
  }

  private closeView(v: View): void {
    if (!v.closed) {
      v.closed = true;
      try {
        v.pty.kill(); // SIGHUP：比 detach-client 快（F7 测量表）
      } catch {
        // 已经退出
      }
    }
    this.views.delete(v.id);
  }

  private checkHealthSoon(): void {
    if (this.disposed || this.healthSoon) return;
    this.healthSoon = setTimeout(() => {
      this.healthSoon = null;
      void this.checkHealth();
    }, 100);
    this.healthSoon.unref?.();
  }

  /** 兜底：发现 pane-died 钩子漏掉的退出、被外面结束的会话，以及 tmux 服务没了（host-lost）。 */
  private async checkHealth(): Promise<void> {
    if (this.disposed || this.stopping || this.healthRunning || this.entries.size === 0) return;
    this.healthRunning = true;
    const startedAt = Date.now();
    try {
      const rows = await this.listSessions().catch(() => undefined);
      if (rows === undefined || this.disposed || this.stopping) return;
      if (rows === null) {
        // 服务不在了，而我们还记着终端
        const had = [...this.entries.values()].some((e) => e.addedAt < startedAt && !e.killing);
        if (!had) return;
        for (const v of [...this.views.values()]) this.closeView(v);
        for (const e of this.entries.values()) this.clearSilence(e);
        this.entries.clear();
        this.emit({ type: 'terminal.host-lost' });
        return;
      }
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const entry of [...this.entries.values()]) {
        if (entry.addedAt >= startedAt || entry.killing) continue;
        const row = byId.get(entry.id);
        if (!row) {
          this.removeEntry(entry);
          if (entry.alive) this.emit({ type: 'terminal.exit', id: entry.id, code: KILLED_EXIT_CODE });
        } else if (row.dead && entry.alive) {
          this.onPaneDied(entry.id, row.exitCode);
        }
      }
    } finally {
      this.healthRunning = false;
    }
  }
}

// ---- list-sessions ----

const SESSION_FORMAT = [
  '#{session_name}',
  '#{pane_current_path}',
  '#{pane_current_command}',
  '#{pane_dead}',
  '#{pane_dead_status}',
  '#{pane_dead_signal}',
  '#{window_activity}',
  '#{window_width}',
  '#{host}',
  // 放最后：标题里可能有任何字符
  '#{pane_title}',
].join('\t');

export interface SessionRow {
  id: TerminalId;
  cwd: string;
  command: string;
  dead: boolean;
  exitCode: number | null;
  /** 秒级时间戳。 */
  activity: number;
  width: number;
  /** 程序设的终端标题（见 cleanTitle）。 */
  title: string | null;
}

/**
 * pane_title → TerminalInfo.title：tmux 默认的标题是主机名，那就是没设过，返回 null；
 * agent 常在标题前面加转圈或状态符号（claude 的 ✳ ⠂ ⠐），去掉开头不是字母数字的部分。
 */
export function cleanTitle(raw: string, host: string): string | null {
  const t = raw.trim();
  if (!t || t === host || t === host.split('.')[0]) return null;
  const stripped = t.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return stripped || null;
}

export function parseSessions(out: string): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [id = '', cwd = '', command = '', dead = '', status = '', signal = '', activity = '', width = '', host = '', ...rest] = line.split('\t');
    if (!id) continue;
    const isDead = dead === '1';
    rows.push({
      id: id as TerminalId,
      cwd,
      command,
      dead: isDead,
      exitCode: isDead ? (exitCodeOf(status, signal) ?? 0) : null,
      activity: Number(activity) || 0,
      width: Number(width) || 0,
      title: cleanTitle(rest.join('\t'), host),
    });
  }
  return rows;
}

function linkKey(link: TerminalLink): string {
  return link.kind === 'localhost' ? `u:${link.url}` : `f:${link.path}:${link.line ?? ''}:${link.column ?? ''}`;
}

function newTerminalId(): TerminalId {
  return `t-${randomBytes(6).toString('hex')}` as TerminalId;
}

function toAgentDeckError(e: unknown, message: string): AgentDeckError {
  if (e instanceof AgentDeckError) return e;
  if (e instanceof TmuxError) {
    if (e.noServer) return new AgentDeckError({ code: 'tmux-unavailable', message: 'The tmux server is not running.', detail: e.stderr });
    return new AgentDeckError({ code: 'internal', message, detail: e.stderr });
  }
  return new AgentDeckError({ code: 'internal', message, detail: e instanceof Error ? e.message : String(e) });
}
