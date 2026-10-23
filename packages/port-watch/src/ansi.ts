// 把终端的原始输出变成“看得见的文字 + 换行”，给找链接用。
// 不是完整的终端模拟：只要让链接前后不粘上别的字、该断行的地方断行。
//   - 光标定位（CSI H f A B E F d、ESC E/D/M）当换行：codex（ratatui）按格子定位画屏，去掉后各行会粘在一起
//   - 光标右移（CSI C）当空格；清行、颜色等其余 CSI 直接去掉
//   - OSC 8 超链接：取出里面的地址单独成行（链接文字可能和地址不一样）；其余 OSC、DCS、APC 去掉
//   - \r\n 和单独的 \r 都当换行（进度条用 \r 覆盖同一行）；退格删掉前一个字

export interface Visible {
  /** 处理过的文字，只含 \n 作为换行。 */
  text: string;
  /** 还没结束的转义序列（这段输出在序列中间被切开了），下次接着处理。 */
  rest: string;
}

const ESC = '\x1b';

export function toVisible(input: string): Visible {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i]!;
    if (c === ESC) {
      if (i + 1 >= n) return { text: out, rest: input.slice(i) };
      const k = input[i + 1]!;
      if (k === '[') {
        // CSI：参数 0x30–0x3F，中间字节 0x20–0x2F，结束字节 0x40–0x7E
        let j = i + 2;
        while (j < n && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x3f) j++;
        if (j >= n) return { text: out, rest: input.slice(i) };
        const final = input[j]!;
        if ('HfABEFd'.includes(final)) out += '\n';
        else if (final === 'C' || final === 'G' || final === '`') out += ' ';
        i = j + 1;
        continue;
      }
      if (k === ']' || k === 'P' || k === '_' || k === '^' || k === 'X') {
        // OSC / DCS / APC / PM / SOS：到 BEL 或 ST（ESC \）为止
        let j = i + 2;
        let end = -1;
        let termLen = 0;
        while (j < n) {
          if (input[j] === '\x07' && k === ']') {
            end = j;
            termLen = 1;
            break;
          }
          if (input[j] === ESC && input[j + 1] === '\\') {
            end = j;
            termLen = 2;
            break;
          }
          if (input[j] === ESC && j + 1 >= n) break;
          j++;
        }
        if (end === -1) {
          // 太长还没结束的就当坏数据丢掉，免得一直攒着
          if (n - i > 8192) {
            i = n;
            continue;
          }
          return { text: out, rest: input.slice(i) };
        }
        if (k === ']') {
          const body = input.slice(i + 2, end);
          const m = /^8;[^;]*;(.*)$/s.exec(body);
          if (m?.[1]) out += `\n${m[1]}\n`;
        }
        i = end + termLen;
        continue;
      }
      if (k === 'E' || k === 'D' || k === 'M') out += '\n';
      // 其他两字节序列（ESC 7、ESC =、ESC ( B 的前半……）
      if (k === '(' || k === ')' || k === '*' || k === '+' || k === '#' || k === '%') {
        if (i + 2 >= n) return { text: out, rest: input.slice(i) };
        i += 3;
        continue;
      }
      i += 2;
      continue;
    }
    if (c === '\r') {
      out += '\n';
      if (input[i + 1] === '\n') i++;
      i++;
      continue;
    }
    if (c === '\b') {
      out = out.slice(0, -1);
      i++;
      continue;
    }
    const code = input.charCodeAt(i);
    if (code < 0x20 && c !== '\n' && c !== '\t') {
      i++;
      continue;
    }
    out += c === '\t' ? ' ' : c;
    i++;
  }
  return { text: out, rest: '' };
}

/** 一次性去掉所有转义序列（测试和简单场合用）。 */
export function stripAnsi(input: string): string {
  return toVisible(input).text;
}
