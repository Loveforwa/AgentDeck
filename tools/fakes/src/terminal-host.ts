// TerminalHost 的内存假实现：不起进程，输出来自录制回放或 feed()。
// 行为对照 packages/contracts/src/terminal.ts 的注释；和真 tmux 不一样的地方写在 AGENTS.md。

import { TERMINAL_ID_ENV } from '@agentdeck/contracts';
import type {
  CreateTerminalRequest,
  IsoTime,
  TermSize,
  TerminalHost,
  TerminalId,
  TerminalInfo,
  TerminalLink,
  ViewId,
} from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';
import type { Recording } from './recording.ts';
import { basename, clone, fail, idGenerator, nowIso, stripAnsi, toPlainLines } from './util.ts';

export interface FakeTerminalHostOptions {
  bus?: FakeEventBus;
  /** create() 时按请求挑录制；返回 null 就没有录制，只回显输入。 */
  recordingFor?: (req: CreateTerminalRequest) => Recording | null;
  /** 什么时候开始回放：第一次 attach（默认，和需求一致）或一创建就开始。 */
  playOn?: 'attach' | 'create';
  /** 多久没输出发 terminal.silence，默认 3000；0 表示不发。 */
  silenceMs?: number;
  /** 输入是否回显到输出，默认 true。 */
  echo?: boolean;
}

export interface CreateWithOptions {
  /** 指定 id，预置示例数据时用。 */
  id?: TerminalId;
  recording?: Recording | null;
  playOn?: 'attach' | 'create';
  /** 覆盖 TerminalInfo.command，例如 shell 里跑着 node。 */
  command?: string;
  /** 已经有的输出（不发事件），模拟应用重开时终端早就在跑。 */
  history?: string;
  /** 创建时就是已退出状态。 */
  exited?: number;
}

/** 测试里查看一个终端的内部状态。 */
export interface FakeTerminalState {
  id: TerminalId;
  request: CreateTerminalRequest;
  env: Record<string, string>;
  size: TermSize;
  alive: boolean;
  exitCode: number | null;
  output: string;
  /** write() 收到的原始输入。 */
  inputs: string[];
  /** sendKeys() 收到的按键，每次调用一组。 */
  keys: string[][];
  recording: string | null;
  /** 回放停在 waitForInput 上。 */
  waitingForInput: boolean;
  /** 回放已经放完（或没有录制）。 */
  playbackDone: boolean;
}

interface Term {
  id: TerminalId;
  request: CreateTerminalRequest;
  env: Record<string, string>;
  size: TermSize;
  command: string;
  alive: boolean;
  exitCode: number | null;
  lastActivityAt: IsoTime | null;
  output: string;
  inputs: string[];
  keys: string[][];
  recording: Recording | null;
  cursor: number;
  started: boolean;
  waiting: boolean;
  playOn: 'attach' | 'create';
  timer: ReturnType<typeof setTimeout> | null;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /** 正在出输出（发过 activity、还没发 silence）。 */
  active: boolean;
  seenLinks: Set<string>;
  /** 最近出现过的链接，新的在前，最多 20 条。 */
  recentLinks: TerminalLink[];
}

interface View {
  id: ViewId;
  terminalId: TerminalId;
  size: TermSize;
  /** 补发完已有输出之后才开始收新输出，避免重复。 */
  ready: boolean;
}

const MAX_OUTPUT = 200_000;
const DEFAULT_SIZE: TermSize = { cols: 80, rows: 24 };

const LOCALHOST_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#][^\s'"<>)\]]*)?/g;
const FILE_RE = /(?:^|[\s('"`])((?:\/|\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z][\w]*):(\d+)(?::(\d+))?/g;

/** 从一段纯文本里找可点的地址：localhost 网址和“文件:行号”。 */
export function findLinks(text: string): TerminalLink[] {
  const links: TerminalLink[] = [];
  for (const m of text.matchAll(LOCALHOST_RE)) {
    links.push({ kind: 'localhost', url: m[0].replace(/[.,;:!]+$/, '') });
  }
  for (const m of text.matchAll(FILE_RE)) {
    const path = m[1];
    if (!path || /^https?$/.test(path)) continue;
    const link: TerminalLink = { kind: 'file', path, line: Number(m[2]) };
    if (m[3] !== undefined) link.column = Number(m[3]);
    links.push(link);
  }
  return links;
}

const NAMED_KEYS: Record<string, string> = {
  Enter: '\r',
  Escape: '\x1b',
  Tab: '\t',
  Space: ' ',
  BSpace: '\x7f',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
};

/** tmux send-keys 的按键名转成终端收到的字节，例如 'Enter' → '\r'、'C-c' → '\x03'。其余原样。 */
export function keysToData(keys: string[]): string {
  return keys
    .map((k) => {
      const named = NAMED_KEYS[k];
      if (named !== undefined) return named;
      const ctrl = /^C-([a-zA-Z])$/.exec(k);
      if (ctrl?.[1]) return String.fromCharCode(ctrl[1].toLowerCase().charCodeAt(0) - 96);
      return k;
    })
    .join('');
}

export class FakeTerminalHost implements TerminalHost {
  readonly bus: FakeEventBus;
  private readonly opts: Required<Omit<FakeTerminalHostOptions, 'bus' | 'recordingFor'>> & {
    recordingFor: FakeTerminalHostOptions['recordingFor'] | undefined;
  };
  private readonly terms = new Map<TerminalId, Term>();
  private readonly viewsById = new Map<ViewId, View>();
  private readonly nextId = idGenerator();

  constructor(opts: FakeTerminalHostOptions = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
    this.opts = {
      playOn: opts.playOn ?? 'attach',
      silenceMs: opts.silenceMs ?? 3000,
      echo: opts.echo ?? true,
      recordingFor: opts.recordingFor,
    };
  }

  // ---- TerminalHost ----

  async create(req: CreateTerminalRequest): Promise<{ id: TerminalId }> {
    return { id: this.createWith(req) };
  }

  async kill(id: TerminalId): Promise<void> {
    const t = this.require(id);
    this.stopTimers(t);
    for (const v of this.viewsById.values()) if (v.terminalId === id) this.viewsById.delete(v.id);
    this.terms.delete(id);
    // 真 tmux 的 kill-session 会给进程发 SIGHUP；这里按 128+1 发一次 exit，见 CONTRACT_NOTES.md。
    if (t.alive) this.bus.emit({ type: 'terminal.exit', id, code: 129 });
  }

  async list(): Promise<TerminalInfo[]> {
    return [...this.terms.values()].map((t) => ({
      id: t.id,
      cwd: t.request.cwd,
      command: t.command,
      alive: t.alive,
      exitCode: t.exitCode,
      lastActivityAt: t.lastActivityAt,
    }));
  }

  async attach(id: TerminalId, size: TermSize): Promise<{ viewId: ViewId }> {
    const t = this.require(id);
    const view: View = { id: this.nextId<ViewId>('view'), terminalId: id, size: { ...size }, ready: false };
    this.viewsById.set(view.id, view);
    t.size = { ...size };
    // 真 tmux 接上后会重画屏幕。这里在下一轮把已有输出补发给这个 view（调用方那时已经拿到 viewId）。
    setTimeout(() => {
      if (!this.viewsById.has(view.id)) return;
      view.ready = true;
      if (t.output) this.bus.emitTerminalData({ viewId: view.id, data: t.output });
    }, 0);
    if (t.playOn === 'attach') this.startPlayback(t);
    return { viewId: view.id };
  }

  async detach(viewId: ViewId): Promise<void> {
    this.viewsById.delete(viewId);
  }

  write(viewId: ViewId, data: string): void {
    const view = this.viewsById.get(viewId);
    const t = view && this.terms.get(view.terminalId);
    if (!t) return;
    t.inputs.push(data);
    this.input(t, data);
  }

  resize(viewId: ViewId, size: TermSize): void {
    const view = this.viewsById.get(viewId);
    const t = view && this.terms.get(view.terminalId);
    if (!view || !t) return;
    view.size = { ...size };
    t.size = { ...size };
  }

  async sendKeys(id: TerminalId, keys: string[]): Promise<void> {
    const t = this.require(id);
    t.keys.push([...keys]);
    this.input(t, keysToData(keys));
  }

  async lastLines(id: TerminalId, n: number): Promise<string[]> {
    const t = this.require(id);
    if (n <= 0) return [];
    const lines = toPlainLines(t.output);
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
    return lines.slice(-n);
  }

  async recentLinks(id: TerminalId): Promise<TerminalLink[]> {
    return clone(this.require(id).recentLinks);
  }

  async attachCommand(id: TerminalId): Promise<string> {
    this.require(id);
    return `tmux -L agentdeck attach-session -t ${id}`;
  }

  // ---- 假实现专用的控制方法 ----

  /** 和 create 一样，但可以指定 id、录制、已有输出。返回终端 id。 */
  createWith(req: CreateTerminalRequest, o: CreateWithOptions = {}): TerminalId {
    const id = o.id ?? this.nextId<TerminalId>('term');
    if (this.terms.has(id)) fail('invalid-argument', `Terminal ${id} already exists`);
    const recording = o.recording !== undefined ? o.recording : (this.opts.recordingFor?.(req) ?? null);
    const t: Term = {
      id,
      request: clone(req),
      // AGENTDECK_TERM 不能被覆盖
      env: { ...req.env, [TERMINAL_ID_ENV]: id },
      size: req.size ? { ...req.size } : { ...DEFAULT_SIZE },
      command: o.command ?? basename(req.cmd),
      alive: o.exited === undefined,
      exitCode: o.exited ?? null,
      lastActivityAt: o.history ? nowIso() : null,
      output: o.history ?? '',
      inputs: [],
      keys: [],
      recording,
      cursor: 0,
      started: false,
      waiting: false,
      playOn: o.playOn ?? this.opts.playOn,
      timer: null,
      silenceTimer: null,
      active: false,
      seenLinks: new Set(),
      recentLinks: [],
    };
    this.terms.set(id, t);
    if (t.playOn === 'create') this.startPlayback(t);
    return id;
  }

  /** 立刻输出一段数据（发 activity / link / silence 事件）。 */
  feed(id: TerminalId, data: string): void {
    const t = this.require(id);
    if (t.alive) this.output(t, data);
  }

  /** 让进程退出。 */
  exit(id: TerminalId, code: number): void {
    const t = this.require(id);
    if (!t.alive) return;
    this.stopTimers(t);
    t.alive = false;
    t.exitCode = code;
    t.active = false;
    this.bus.emit({ type: 'terminal.exit', id, code });
  }

  /** 开始回放；传 recording 就换一段，从头放。 */
  play(id: TerminalId, recording?: Recording): void {
    const t = this.require(id);
    if (recording) {
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      t.recording = recording;
      t.cursor = 0;
      t.started = false;
      t.waiting = false;
    }
    this.startPlayback(t);
  }

  /** 模拟 tmux 服务没了：所有终端消失，发 terminal.host-lost。 */
  hostLost(): void {
    for (const t of this.terms.values()) this.stopTimers(t);
    this.terms.clear();
    this.viewsById.clear();
    this.bus.emit({ type: 'terminal.host-lost' });
  }

  has(id: TerminalId): boolean {
    return this.terms.has(id);
  }

  get(id: TerminalId): FakeTerminalState {
    const t = this.require(id);
    return clone({
      id: t.id,
      request: t.request,
      env: t.env,
      size: t.size,
      alive: t.alive,
      exitCode: t.exitCode,
      output: t.output,
      inputs: t.inputs,
      keys: t.keys,
      recording: t.recording?.name ?? null,
      waitingForInput: t.waiting,
      playbackDone: !t.recording || t.cursor >= t.recording.events.length,
    });
  }

  /** 当前接上的 view。 */
  views(id?: TerminalId): { viewId: ViewId; terminalId: TerminalId; size: TermSize }[] {
    return [...this.viewsById.values()]
      .filter((v) => id === undefined || v.terminalId === id)
      .map((v) => ({ viewId: v.id, terminalId: v.terminalId, size: { ...v.size } }));
  }

  /** 停掉所有计时器。测试结束或界面热更新时调用。 */
  dispose(): void {
    for (const t of this.terms.values()) this.stopTimers(t);
  }

  // ---- 内部 ----

  private require(id: TerminalId): Term {
    const t = this.terms.get(id);
    if (!t) fail('not-found', `Terminal ${id} not found`);
    return t;
  }

  private input(t: Term, data: string): void {
    if (!t.alive) return;
    if (this.opts.echo) {
      const echoed = data.replace(/\r/g, '\r\n').replace(/\x7f/g, '\b \b');
      if (echoed) this.output(t, echoed);
    }
    if (t.waiting) {
      t.waiting = false;
      this.scheduleNext(t);
    }
  }

  private output(t: Term, data: string): void {
    t.output += data;
    if (t.output.length > MAX_OUTPUT) t.output = t.output.slice(-MAX_OUTPUT / 2);
    const at = nowIso();
    t.lastActivityAt = at;
    for (const v of this.viewsById.values()) {
      if (v.terminalId === t.id && v.ready) this.bus.emitTerminalData({ viewId: v.id, data });
    }
    // 一段连续输出只发一次 activity，停下 silenceMs 后发 silence，接近 tmux monitor-activity / monitor-silence。
    if (!t.active) {
      t.active = true;
      this.bus.emit({ type: 'terminal.activity', id: t.id, at });
    }
    for (const link of findLinks(stripAnsi(data))) {
      const key = JSON.stringify(link);
      if (t.seenLinks.has(key)) continue;
      t.seenLinks.add(key);
      t.recentLinks = [link, ...t.recentLinks].slice(0, 20);
      this.bus.emit({ type: 'terminal.link', id: t.id, link });
    }
    if (t.silenceTimer) clearTimeout(t.silenceTimer);
    t.silenceTimer = null;
    if (this.opts.silenceMs > 0) {
      t.silenceTimer = setTimeout(() => {
        t.silenceTimer = null;
        t.active = false;
        this.bus.emit({ type: 'terminal.silence', id: t.id, at: nowIso() });
      }, this.opts.silenceMs);
    }
  }

  private startPlayback(t: Term): void {
    if (t.started || !t.recording || !t.alive) return;
    t.started = true;
    this.scheduleNext(t);
  }

  private scheduleNext(t: Term): void {
    const ev = t.recording?.events[t.cursor];
    if (!ev || t.waiting || !t.alive || t.timer) return;
    t.timer = setTimeout(() => {
      t.timer = null;
      t.cursor += 1;
      if ('data' in ev) {
        this.output(t, ev.data);
        this.scheduleNext(t);
      } else if ('waitForInput' in ev) {
        t.waiting = true;
      } else {
        this.exit(t.id, ev.exit);
      }
    }, ev.delayMs);
  }

  private stopTimers(t: Term): void {
    if (t.timer) clearTimeout(t.timer);
    if (t.silenceTimer) clearTimeout(t.silenceTimer);
    t.timer = null;
    t.silenceTimer = null;
  }
}
