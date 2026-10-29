// 一个终端窗口里的 xterm：显示、输入、attach / detach。不依赖 React，组件只调它的方法。
//
// 照 packages/tmux-host/AGENTS.md 必须做的几件事：
//   问题 1  替 xterm 回答 XTVERSION 和 OSC 10/11（queries.ts）
//   问题 2  attach 后收到第一段输出之前，用户输入先扣住
//   问题 10 Shift+Enter 发 CSI 13;2u（keys.ts）
//   问题 11 macOptionClickForcesSelection；tmux 回滚里的选中经 OSC 52 到 clipboard 插件
//   attach 前 reset xterm；改大小松手后才 resize；只为视口里的终端 attach（由组件决定什么时候调）

import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type IDisposable, type ILink, type ILinkProvider } from '@xterm/xterm';
import type { AgentDeckApi, TermSize, TerminalId, TerminalLink, Unsubscribe, ViewId } from '@agentdeck/contracts';
import { decideKey } from './keys.ts';
import { findLinkMatches } from './links.ts';
import { FONT_SIZE, LINE_HEIGHT, termSizeFor } from './metrics.ts';
import { installQueryAnswers, type QueryAnswers } from './queries.ts';
import { routerFor } from './router.ts';
import { readColors, type TermColors } from './theme.ts';
import { fixMouseForZoom } from './zoom.ts';

/** 内容区大小变了以后，盯着容器实际大小的时长（IS-49）。 */
const FIT_WINDOW_MS = 1000;
/** CO3：tmux 在拖选、双击、三击松手后经 OSC 52 发来复制的文字；这么久之内到的才算“用鼠标选中的”（双击要等 tmux 的 run -d 0.3）。 */
const MOUSE_COPY_MS = 2000;
/** 拖动超过这么多像素才算拖选（不是单击）。 */
const DRAG_PX = 4;
/** 拖选松手后这么久还没有 OSC 52、xterm 也没选中：程序要鼠标（codex），这次拖动什么都没选上。 */
const EMPTY_DRAG_MS = 700;
/** 粘贴前等输出停下来的时长：刚接上显示时 tmux 在重画，刚开的程序在打印启动画面。 */
const SETTLE_MS = 300;
const FRESH_SETTLE_MS = 1500;
/** 等接上显示、等程序准备好的上限。 */
const READY_TIMEOUT_MS = 5000;
const FRESH_READY_TIMEOUT_MS = 20_000;

/** deliver() 的结果，同 @agentdeck/ui-canvas/registry 的 PasteResult。 */
export type DeliverResult = { ok: true } | { ok: false; reason: 'not-ready' | 'not-bracketed' };

export interface TerminalSessionOptions {
  api: AgentDeckApi;
  /** xterm 画在这里面。 */
  container: HTMLElement;
  /** 单击输出里的链接。OSC 8 里不是 localhost 的网址也走这里（kind 为 'external'）。 */
  onLink(link: TerminalLink | { kind: 'external'; url: string }): void;
  /** 每次 attach 后收到第一段输出。 */
  onFirstData?(): void;
  /** 渲染失败等不影响使用的问题，dev 页面里打出来。 */
  onWarning?(message: string): void;
  /** CO3：拖动松手后什么都没选上（程序要鼠标，例如 codex），提示按住 Option 拖。 */
  onEmptyDrag?(): void;
  isMac?: boolean;
  /** 测试里关掉 WebGL。 */
  webgl?: boolean;
}

export class TerminalSession {
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private webgl: WebglAddon | null = null;
  private colors: TermColors;
  private readonly queries: QueryAnswers;
  private readonly disposables: IDisposable[] = [];
  private readonly isMac: boolean;

  private viewId: ViewId | null = null;
  private terminalId: TerminalId | null = null;
  /** 每次 attach / detach 加一，晚到的 attach 结果对不上就丢掉。 */
  private generation = 0;
  private unlisten: Unsubscribe | null = null;
  /** 收到第一段输出之前扣住的输入（问题 2）。 */
  private held: string[] | null = null;
  private size: TermSize;
  private disposed = false;
  /** 这次 attach 收到第一段输出了（之后 xterm 的 bracketed paste 模式才和 tmux 里的程序一致）。 */
  private gotFirst = false;
  private lastOutputAt = 0;
  /**
   * CO3：用鼠标在 tmux 里选中、松手就复制走的文字（tmux 的 copy-pipe-and-cancel，选中的高亮随即消失）。
   * Send selection to ▸ 把它当作“选中的文字”。下一次左键按下、在这个终端里按键时清掉。
   */
  private mouseCopy: string | null = null;
  /** 最近一次左键松手（拖选、双击、三击）的时间，判断 OSC 52 是不是这次选中带来的。 */
  private pointerUpAt = Number.NEGATIVE_INFINITY;
  /** 最近一次收到 OSC 52 的时间。 */
  private copiedAt = Number.NEGATIVE_INFINITY;
  private dragStart: { x: number; y: number; at: number } | null = null;
  private emptyDragTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: TerminalSessionOptions) {
    this.isMac = opts.isMac ?? /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    this.colors = readColors(opts.container);
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: getComputedStyle(opts.container).getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      // 回滚历史在 tmux 里（tmux 用外层的备用屏，xterm 自己的回滚基本用不上）。但不能设成 0：
      // xterm 6 在 scrollback 为 0 时，改大小后缓冲区的行数可能少于屏幕行数，渲染器读到不存在的行就抛
      // “reading 'loadCell'”、写入时抛 “setting 'isWrapped'”，整个终端停止刷新（IS-39，test/xterm-buffer.test.ts 复现）
      scrollback: 1000,
      cursorBlink: false,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      // macOS 上默认右键会选中指针下的词：会盖掉 tmux 刚复制的那段、凭空多出一个“选中”，Send selection to ▸ 就送错了（CO3）
      rightClickSelectsWord: false,
      theme: this.colors.theme,
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (_e, text) => this.activateHyperlink(text),
      },
    });
    this.size = { cols: this.term.cols, rows: this.term.rows };
    this.term.loadAddon(this.fit);
    // 字符宽度按 Unicode 11 算，和 tmux 一致（2026-10-24 对 tmux 3.6a 实测 35 个 claude 常用符号，全部吻合）。
    // xterm 默认是 Unicode 6：✅ ❌ ⚡ ⏳ 🙂 🤖 这类 emoji 在 tmux 里占两格、在 xterm 里占一格，
    // 后面的字整体错一列，看起来就是重叠、断开（IS-40）
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    // OSC 52：tmux 回滚里拖选、claude 的 /copy 都经它写系统剪贴板；不许程序读剪贴板
    this.term.loadAddon(
      new ClipboardAddon(undefined, {
        readText: () => '',
        writeText: (_sel, text) => {
          this.noteCopied(text);
          return navigator.clipboard?.writeText(text);
        },
      }),
    );
    this.term.open(opts.container);
    // 白板不在 100% 时点链接、拖选、双击不偏（IS-82）
    fixMouseForZoom(this.term);
    // 调试和端到端测试用：从 DOM 拿到这个终端（document.querySelector('.ad-terminal__xterm').agentdeckSession）
    Object.defineProperty(opts.container, 'agentdeckSession', { value: this, configurable: true });

    this.queries = installQueryAnswers(this.term.parser, (d) => this.send(d), () => this.colors);
    this.disposables.push(
      this.queries,
      this.term.onData((d) => this.send(d)),
      this.term.onBinary((d) => this.send(d)),
      this.term.registerLinkProvider(this.linkProvider()),
      // 在这个终端里打字：刚才鼠标复制的那段不再算“选中”
      this.term.onKey(() => {
        this.mouseCopy = null;
      }),
    );
    this.watchPointer(opts.container);
    // 等宽字体（JetBrains Mono）可能在 xterm 量格子之后才加载完：加载完再量一次，否则字会挤在一起或留缝
    void document.fonts?.ready.then(() => {
      if (this.disposed) return;
      const family = this.term.options.fontFamily ?? 'monospace';
      this.term.options.fontFamily = `${family} `;
      this.term.options.fontFamily = family;
      this.fitToContainer();
    });
    this.term.attachCustomKeyEventHandler((e) => {
      const d = decideKey(e, this.isMac);
      if (d.kind === 'terminal') return true;
      if (d.kind === 'send') {
        e.preventDefault();
        this.send(d.data);
      }
      return false;
    });
  }

  // ---- 显示连接 ----

  /** 接上显示：先 reset，再按当前大小 attach；第一段输出之前的输入先扣住。 */
  async attach(terminalId: TerminalId): Promise<void> {
    this.detach();
    const gen = ++this.generation;
    this.terminalId = terminalId;
    this.term.reset();
    this.held = [];
    this.gotFirst = false;
    this.loadWebgl();
    const size = this.measure() ?? this.size;
    if (size.cols !== this.term.cols || size.rows !== this.term.rows) this.term.resize(size.cols, size.rows);
    this.size = size;
    const { viewId } = await this.opts.api.terminals.attach(terminalId, size);
    if (gen !== this.generation || this.disposed) {
      void this.opts.api.terminals.detach(viewId).catch(() => {});
      return;
    }
    this.viewId = viewId;
    // attach 在路上时大小可能又变了（字体刚加载完、窗口刚改大小），补一次 resize，不然 tmux 按旧的行列数画
    if (this.size.cols !== size.cols || this.size.rows !== size.rows) this.opts.api.terminals.resize(viewId, this.size);
    let first = true;
    this.unlisten = routerFor(this.opts.api).listen(viewId, (data) => {
      this.term.write(data);
      this.lastOutputAt = Date.now();
      if (first) {
        this.gotFirst = true;
        first = false;
        this.release();
        this.opts.onFirstData?.();
      }
    });
  }

  /** 断开显示（移出视口、变摘要卡、卸载）。xterm 里的内容留着，下次 attach 前再 reset。 */
  detach(): void {
    this.generation++;
    this.unlisten?.();
    this.unlisten = null;
    if (this.viewId !== null) void this.opts.api.terminals.detach(this.viewId).catch(() => {});
    this.viewId = null;
    this.held = null;
    this.gotFirst = false;
    // 看不见的终端不占 WebGL 上下文（浏览器同时只给十几个）
    this.webgl?.dispose();
    this.webgl = null;
  }

  get attached(): boolean {
    return this.viewId !== null;
  }

  /** 内容区大小变了（改大小松手后）：按实际格子大小重算行列数，变了才告诉 tmux。 */
  fitToContainer(fallback?: { w: number; h: number }): void {
    const size = this.measure() ?? (fallback ? termSizeFor(fallback) : null);
    if (!size || (size.cols === this.size.cols && size.rows === this.size.rows)) return;
    this.size = size;
    this.term.resize(size.cols, size.rows);
    if (this.viewId !== null) this.opts.api.terminals.resize(this.viewId, size);
  }

  /**
   * 白板给的内容区大小变了（改大小松手、放大、还原）：这时白板可能还没把新大小排到页面上（React Flow 下一帧才改节点大小），
   * 马上量会量到旧的大小，放大后终端还是原来的行列数、还原后反而按放大的画（IS-49）。所以等排版：之后 1 秒内容器的实际大小
   * 每变一次就重量一次（ResizeObserver 开始观察时也会报一次当前大小）。返回取消函数。
   */
  fitAfterLayout(fallback?: { w: number; h: number }): () => void {
    if (typeof ResizeObserver === 'undefined') {
      this.fitToContainer(fallback);
      return () => {};
    }
    const ro = new ResizeObserver(() => this.fitToContainer(fallback));
    ro.observe(this.opts.container);
    const timer = setTimeout(() => ro.disconnect(), FIT_WINDOW_MS);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }

  currentSize(): TermSize {
    return this.measure() ?? this.size;
  }

  // ---- 输入 ----

  /** 写给终端：没接上或者还没收到首屏时先扣住。 */
  send(data: string): void {
    if (this.held !== null) {
      this.held.push(data);
      return;
    }
    if (this.viewId !== null) this.opts.api.terminals.write(this.viewId, data);
  }

  /** 粘贴（拖进来的文件路径也走这里）：xterm 按程序的 bracketed paste 模式加标记。 */
  paste(text: string): void {
    this.term.paste(text);
  }

  /**
   * CO3：现在选中的文字。xterm 自己的选中（按住 Option 拖）优先；没有时是刚用鼠标在 tmux 里选中、松手复制走的那段。没有为 ''。
   */
  selectionText(): string {
    if (this.term.hasSelection()) return this.term.getSelection();
    return this.mouseCopy ?? '';
  }

  /** 已接上显示、收到首屏，粘贴能按程序的 bracketed paste 模式加标记。 */
  get ready(): boolean {
    return this.viewId !== null && this.gotFirst;
  }

  /**
   * CO3：Send selection to ▸ 送来的文字，当作一次粘贴（不按回车）。还没接上显示就等接上（跳过去以后才 attach）；
   * 接上后等输出停一下（tmux 的重画、刚开的程序的启动画面），fresh 时等得更久，或等程序开了 bracketed paste。
   * requireBracketed 且程序没开 bracketed paste 时，多行文字会被一行行执行：不贴，返回 not-bracketed。
   */
  async deliver(text: string, opts: { requireBracketed?: boolean; fresh?: boolean } = {}): Promise<DeliverResult> {
    const fresh = opts.fresh ?? false;
    const settle = fresh ? FRESH_SETTLE_MS : SETTLE_MS;
    const ok = await this.waitUntil(
      () => this.ready && (Date.now() - this.lastOutputAt >= settle || (fresh && this.term.modes.bracketedPasteMode && Date.now() - this.lastOutputAt >= SETTLE_MS)),
      fresh ? FRESH_READY_TIMEOUT_MS : READY_TIMEOUT_MS,
    );
    if (!ok) return { ok: false, reason: 'not-ready' };
    if ((opts.requireBracketed ?? true) && /[\r\n]/.test(text) && !this.term.modes.bracketedPasteMode) return { ok: false, reason: 'not-bracketed' };
    this.paste(text);
    return { ok: true };
  }

  focus(): void {
    this.term.focus();
  }

  blur(): void {
    this.term.blur();
  }

  /** ⌘K：清掉本地显示。tmux 那边的清屏由组件发 C-l。 */
  clear(): void {
    this.term.clear();
  }

  /** 深浅色切换后重新读 tokens；深浅变了就告诉 tmux（再转给 claude，IS-42）。 */
  refreshTheme(): void {
    const wasDark = this.colors.dark;
    this.colors = readColors(this.opts.container);
    this.term.options.theme = this.colors.theme;
    if (this.colors.dark !== wasDark) this.queries.themeChanged();
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    if (this.emptyDragTimer) clearTimeout(this.emptyDragTimer);
    for (const d of this.disposables) d.dispose();
    this.term.dispose();
  }

  // ---- 内部 ----

  private waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
    if (cond()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (this.disposed) {
          clearInterval(tick);
          resolve(false);
        } else if (cond()) {
          clearInterval(tick);
          resolve(true);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(tick);
          resolve(false);
        }
      }, 50);
    });
  }

  /** OSC 52：紧跟着这个终端里的一次鼠标选中（tmux 松手就复制）才记成“选中的文字”；程序自己发的（claude 的 /copy）不算。 */
  private noteCopied(text: string): void {
    this.copiedAt = Date.now();
    if (this.dragStart || Date.now() - this.pointerUpAt <= MOUSE_COPY_MS) this.mouseCopy = text;
  }

  /**
   * 看鼠标（捕获阶段，xterm 之前）：左键按下清掉上一次的鼠标复制；拖动松手后 EMPTY_DRAG_MS 内没有 OSC 52、xterm 也没选中，
   * 说明拖动交给了要鼠标的程序（codex），什么都没选上 → onEmptyDrag。按住 Option（xterm 自己的选中）不算。
   */
  private watchPointer(el: HTMLElement): void {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      this.mouseCopy = null;
      this.dragStart = e.altKey || e.shiftKey ? null : { x: e.clientX, y: e.clientY, at: Date.now() };
      const doc = el.ownerDocument;
      const onUp = (u: PointerEvent) => {
        doc.removeEventListener('pointerup', onUp, true);
        this.pointerUpAt = Date.now();
        const start = this.dragStart;
        this.dragStart = null;
        if (!start || Math.hypot(u.clientX - start.x, u.clientY - start.y) < DRAG_PX) return;
        if (this.emptyDragTimer) clearTimeout(this.emptyDragTimer);
        this.emptyDragTimer = setTimeout(() => {
          this.emptyDragTimer = null;
          if (this.disposed || this.copiedAt >= start.at || this.term.hasSelection()) return;
          this.opts.onEmptyDrag?.();
        }, EMPTY_DRAG_MS);
      };
      doc.addEventListener('pointerup', onUp, true);
    };
    el.addEventListener('pointerdown', onDown, true);
    this.disposables.push({ dispose: () => el.removeEventListener('pointerdown', onDown, true) });
  }

  private release(): void {
    const held = this.held;
    this.held = null;
    if (held && this.viewId !== null) for (const d of held) this.opts.api.terminals.write(this.viewId, d);
  }

  private measure(): TermSize | null {
    try {
      const d = this.fit.proposeDimensions();
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols < 2 || d.rows < 1) return null;
      return { cols: d.cols, rows: d.rows };
    } catch {
      return null;
    }
  }

  private loadWebgl(): void {
    if (this.webgl || this.opts.webgl === false) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        if (this.webgl === addon) this.webgl = null;
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch (e) {
      // 没有 WebGL 时用 xterm 自带的 DOM 渲染
      this.opts.onWarning?.(`WebGL renderer unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 屏幕上的链接：把被 xterm 折行的几行接起来找，再把位置换回每一行的格子。 */
  private linkProvider(): ILinkProvider {
    return {
      provideLinks: (y, callback) => {
        const buf = this.term.buffer.active;
        // y 从 1 开始。往上找到这一段折行的第一行
        let start = y - 1;
        while (start > 0 && buf.getLine(start)?.isWrapped) start--;
        let end = y - 1;
        while (buf.getLine(end + 1)?.isWrapped) end++;
        const cols = this.term.cols;
        let text = '';
        for (let i = start; i <= end; i++) text += buf.getLine(i)?.translateToString(i === end) ?? '';
        const links: ILink[] = [];
        for (const m of findLinkMatches(text)) {
          const sy = start + Math.floor(m.start / cols);
          const ey = start + Math.floor((m.end - 1) / cols);
          if (y - 1 < sy || y - 1 > ey) continue;
          links.push({
            range: { start: { x: (m.start % cols) + 1, y: sy + 1 }, end: { x: ((m.end - 1) % cols) + 1, y: ey + 1 } },
            text: text.slice(m.start, m.end),
            decorations: { pointerCursor: true, underline: true },
            activate: () => this.opts.onLink(m.link),
          });
        }
        callback(links.length > 0 ? links : undefined);
      },
    };
  }

  /** OSC 8 超链接：localhost 和 file:// 当作我们的链接，其他网址交给系统浏览器。 */
  private activateHyperlink(uri: string): void {
    const local = findLinkMatches(uri).find((m) => m.start === 0 && m.link.kind === 'localhost');
    if (local) {
      this.opts.onLink(local.link);
      return;
    }
    if (uri.startsWith('file://')) {
      try {
        const u = new URL(uri);
        const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(decodeURIComponent(u.pathname));
        const link: TerminalLink = { kind: 'file', path: m?.[1] ?? u.pathname };
        if (m?.[2]) link.line = Number(m[2]);
        if (m?.[3]) link.column = Number(m[3]);
        this.opts.onLink(link);
      } catch {
        // 坏地址不处理
      }
      return;
    }
    if (/^https?:\/\//i.test(uri)) this.opts.onLink({ kind: 'external', url: uri });
  }
}
