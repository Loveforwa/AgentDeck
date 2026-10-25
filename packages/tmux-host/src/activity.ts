// 一个终端的输出活动：什么时候发 terminal.activity / terminal.silence（问题 6），以及改大小后的重画不算活动（IS-72）。
//
// - 一段连续输出只发一次 activity；最后一次输出或输入之后 silenceMs 发 silence。
// - 改大小（attach 换了尺寸、resize）之后 quietMs 内、终端本来是安静的时候来的输出不发 activity：
//   shell 收到 SIGWINCH 会重画提示符，TUI 会重画整屏，这不是程序在干活。静默计时照常（silence 的时机和以前一样）。
//   窗口过后还有输出就照常发 activity，所以真在输出的程序最多晚 quietMs 被看到。
// - 这个终端的第一次 activity 不压（新建时 attach 和程序启动是同时的，启动画面要能让状态机离开 starting）；
//   重开应用接回的终端（adopted）没有这个例外，状态机那边已经按 idle 接上了。

export interface ActivityTrackerOptions {
  silenceMs: number;
  /** 改大小之后多久内的输出不算活动。0 表示不压。 */
  quietMs: number;
  onActivity(at: number): void;
  onSilence(at: number): void;
  /** 静默计时器到点时（发不发 silence 都调用），host 用它把链接识别器里没换行的最后一段 flush 掉。 */
  onTimer?(): void;
  /** 进程还活着才发 silence。 */
  alive(): boolean;
  now?: () => number;
}

export class ActivityTracker {
  private active = false;
  /** 上次 silence 之后有过输出或输入，静默计时器到点时才发 silence。 */
  private pendingSilence = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private quietUntil = 0;
  /** 发过 activity（或是接回的终端）。之前的输出不压。 */
  private seen: boolean;
  private readonly opts: ActivityTrackerOptions;
  private readonly now: () => number;

  constructor(opts: ActivityTrackerOptions, o: { adopted?: boolean } = {}) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.seen = o.adopted ?? false;
  }

  /** 来了一段输出。返回 false 表示这段是改大小引起的重画，没算活动。 */
  output(): boolean {
    const now = this.now();
    const quiet = !this.active && this.seen && now < this.quietUntil;
    if (!quiet && !this.active) {
      this.active = true;
      this.seen = true;
      this.opts.onActivity(now);
    }
    this.arm();
    return !quiet;
  }

  /** 用户输入：重新计时（用户按了 Esc 但程序什么都没输出时，状态机也要能等到 silence）。 */
  input(): void {
    this.arm();
  }

  /** 这个终端的窗口大小变了（这边的 attach / resize 引起的），接下来 quietMs 内的重画不算活动。 */
  resized(): void {
    if (this.opts.quietMs > 0) this.quietUntil = Math.max(this.quietUntil, this.now() + this.opts.quietMs);
  }

  /** 进程退出、终端去掉、host dispose：停计时器，不再发 silence。 */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingSilence = false;
    this.active = false;
  }

  private arm(): void {
    this.pendingSilence = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.opts.silenceMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.opts.onTimer?.();
      if (!this.pendingSilence || !this.opts.alive()) return;
      this.pendingSilence = false;
      this.active = false;
      this.opts.onSilence(this.now());
    }, this.opts.silenceMs);
    this.timer.unref?.();
  }
}
