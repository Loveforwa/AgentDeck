// 一个终端一个：tmux-host 把 pipe-pane 抄来的原始输出一段段喂进来，吐出新出现的链接。
// 处理三件事：转义序列可能在两段之间被切开；一行可能分几段到达；程序按窗格宽度把长地址折成了几行。

import type { TerminalLink } from '@agentdeck/contracts';
import { toVisible } from './ansi.ts';
import { findLinks } from './links.ts';

export interface LinkWatcher {
  push(data: string): TerminalLink[];
  /** 把还没换行的最后一段也算上（输出停下来时调用）。 */
  flush(): TerminalLink[];
  /** 窗格宽度。一行正好占满宽度、又停在地址中间时，和下一行接起来再找。 */
  setWidth(cols: number): void;
}

/** 一行最多攒这么多字（有的程序很久不换行，例如进度条），超过就按已有的先算。 */
const MAX_LINE = 4096;

export function createLinkWatcher(opts: { cols?: number } = {}): LinkWatcher {
  let escRest = '';
  let line = '';
  /** 上一行正好占满宽度，并且结尾像是没写完的地址或路径：留着和下一行拼。 */
  let wrapped: string | null = null;
  let cols = opts.cols ?? 0;

  const scan = (complete: string): TerminalLink[] => {
    if (wrapped !== null) {
      const joined = wrapped + complete;
      wrapped = null;
      // 只要接起来的那一个；两行各自的链接已经单独算过（前一行还没有算，这里一起算）
      return findLinks(joined);
    }
    if (cols > 0 && [...complete].length >= cols && /[\w/.:?#=&%-]$/.test(complete) && endsInsideLink(complete)) {
      wrapped = complete;
      return [];
    }
    return findLinks(complete);
  };

  return {
    push(data) {
      const v = toVisible(escRest + data);
      escRest = v.rest;
      const parts = (line + v.text).split('\n');
      line = parts.pop() ?? '';
      const out: TerminalLink[] = [];
      for (const p of parts) out.push(...scan(p));
      if (line.length > MAX_LINE) {
        out.push(...scan(line));
        line = '';
      }
      return out;
    },
    flush() {
      const out: TerminalLink[] = [];
      if (line) out.push(...scan(line));
      line = '';
      if (wrapped !== null) {
        out.push(...findLinks(wrapped));
        wrapped = null;
      }
      return out;
    },
    setWidth(c) {
      cols = c;
    },
  };
}

/** 一行的最后一个词是不是地址或路径的开头部分。 */
function endsInsideLink(line: string): boolean {
  const last = /\S+$/.exec(line)?.[0] ?? '';
  return /^(?:https?:\/\/|localhost:|127\.0\.0\.1:|\.{0,2}\/|[\w@.-]+\/)/i.test(last) || /^[\w@.-]+\.[A-Za-z]\w*:?\d*$/.test(last);
}
