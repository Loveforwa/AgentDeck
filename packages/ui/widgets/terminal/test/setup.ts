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
    constructor(options: Record<string, unknown> = {}) {
      const { linkHandler: _l, theme: _t, macOptionIsMeta: _m, macOptionClickForcesSelection: _c, fontFamily: _f, fontSize: _s, lineHeight: _h, cursorBlink: _b, ...rest } = options;
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
  ClipboardAddon: class {
    activate(): void {}
    dispose(): void {}
  },
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

afterEach(() => {
  cleanup();
});
