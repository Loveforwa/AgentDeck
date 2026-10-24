// 替 xterm.js 回答 tmux 每次 attach 都会发的查询（packages/tmux-host/AGENTS.md 问题 1）。
// 不回答 XTVERSION 和 OSC 10/11 时，attach 后 5 秒内单独按 Esc 会被 tmux 扣住 500ms（实测 501ms，回答后 1.4ms）。
// 两个都要回答；顺手回答 CSI ? 996 n（深浅色主题）。
// tmux 3.6 attach 时还会打开 ?2031（深浅色变化通知）：打开以后白板换深浅色就主动发 CSI ? 997 ; 1|2 n，
// tmux 转给打开了 2031 的程序（claude 的 auto 主题靠它重新问背景色，IS-42）。

/** 用到的 xterm 解析器接口（@xterm/xterm 和 @xterm/headless 一样）。 */
export interface ParserLike {
  registerCsiHandler(id: { prefix?: string; final: string }, cb: (params: (number | number[])[]) => boolean): { dispose(): void };
  registerOscHandler(ident: number, cb: (data: string) => boolean): { dispose(): void };
}

export interface QueryColors {
  fg: string;
  bg: string;
  dark: boolean;
}

export interface QueryAnswers {
  dispose(): void;
  /** 深浅色换了以后调用：对方打开了 ?2031 才发通知。 */
  themeChanged(): void;
}

const THEME_UPDATES = 2031;

export function installQueryAnswers(parser: ParserLike, write: (data: string) => void, colors: () => QueryColors): QueryAnswers {
  let themeUpdates = false;
  // 只记下 2031 的开关，返回 false 让 xterm 照常处理同一条里的其他模式
  const trackMode = (on: boolean) => (params: (number | number[])[]) => {
    if (params.includes(THEME_UPDATES)) themeUpdates = on;
    return false;
  };
  const themeReport = () => `\x1b[?997;${colors().dark ? 1 : 2}n`;
  const handlers = [
    parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => {
      write('\x1bP>|xterm.js\x1b\\');
      return true;
    }),
    parser.registerOscHandler(10, (data) => {
      if (data !== '?') return false;
      write(`\x1b]10;${colors().fg}\x1b\\`);
      return true;
    }),
    parser.registerOscHandler(11, (data) => {
      if (data !== '?') return false;
      write(`\x1b]11;${colors().bg}\x1b\\`);
      return true;
    }),
    parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
      if (params[0] !== 996) return false;
      write(themeReport());
      return true;
    }),
    parser.registerCsiHandler({ prefix: '?', final: 'h' }, trackMode(true)),
    parser.registerCsiHandler({ prefix: '?', final: 'l' }, trackMode(false)),
  ];
  return {
    dispose: () => handlers.forEach((h) => h.dispose()),
    themeChanged: () => {
      if (themeUpdates) write(themeReport());
    },
  };
}
