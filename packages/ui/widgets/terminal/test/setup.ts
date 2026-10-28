// jsdom 里没有 canvas / WebGL，真 xterm 画不出来。用 @xterm/headless（同一套解析器和缓冲区）垫一个假的 @xterm/xterm：
// 输出真的解析进缓冲区，查询回答、bracketed paste 都和真的一样；open / focus / 按键钩子 / 链接只记下来给测试用。

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

vi.mock('@xterm/xterm', async () => {
  const { Terminal: Headless } = await import('@xterm/headless');
  class Terminal extends Headless {
    element: HTMLElement | null = null;
    focused = false;
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    linkProviders: { provideLinks(y: number, cb: (links: unknown[] | undefined) => void): void }[] = [];
    resets = 0;
    /** 测试用：xterm 自己的选中（按住 Option 拖）。headless 没有选中。 */
    selection = '';
    private keyListeners = new Set<() => void>();
    constructor(options: Record<string, unknown> = {}) {
      const {
        linkHandler: _l,
        theme: _t,
        macOptionIsMeta: _m,
        macOptionClickForcesSelection: _c,
        rightClickSelectsWord: _r,
        fontFamily: _f,
        fontSize: _s,
        lineHeight: _h,
        cursorBlink: _b,
        ...rest
      } = options;
      super({ allowProposedApi: true, ...rest, cols: 80, rows: 24 });
      (this as unknown as { initialOptions: Record<string, unknown> }).initialOptions = options;
    }
    open(el: HTMLElement): void {
      this.element = document.createElement('div');
      this.element.className = 'xterm';
      el.appendChild(this.element);
    }
    focus(): void {
      this.focused = true;
    }
    blur(): void {
      this.focused = false;
    }
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean): void {
      this.keyHandler = fn;
    }
    registerLinkProvider(p: Terminal['linkProviders'][number]): { dispose(): void } {
      this.linkProviders.push(p);
      return { dispose: () => {} };
    }
    hasSelection(): boolean {
      return this.selection !== '';
    }
    getSelection(): string {
      return this.selection;
    }
    onKey(fn: () => void): { dispose(): void } {
      this.keyListeners.add(fn);
      return { dispose: () => this.keyListeners.delete(fn) };
    }
    /** 测试用：用户在终端里按了一个键。 */
    pressKey(): void {
      for (const fn of this.keyListeners) fn();
    }
    paste(text: string): void {
      const body = text.replace(/\r?\n/g, '\r');
      this.input(this.modes.bracketedPasteMode ? `\x1b[200~${body}\x1b[201~` : body, true);
    }
    override reset(): void {
      this.resets++;
      super.reset();
    }
  }
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate(): void {}
    dispose(): void {}
    proposeDimensions(): undefined {
      return undefined;
    }
  },
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    activate(): void {}
    dispose(): void {}
    onContextLoss(): { dispose(): void } {
      return { dispose: () => {} };
    }
  },
}));

vi.mock('@xterm/addon-clipboard', () => ({
  // 记下最近一个终端的剪贴板 provider，测试里调 writeText 模拟 tmux 经 OSC 52 发来复制的文字
  ClipboardAddon: class {
    constructor(_base: unknown, provider: unknown) {
      (globalThis as { __lastClipboard?: unknown }).__lastClipboard = provider;
    }
    activate(): void {}
    dispose(): void {}
  },
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

afterEach(() => {
  cleanup();
});
