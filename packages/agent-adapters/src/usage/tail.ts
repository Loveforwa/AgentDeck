// 增量读 jsonl：记住读到哪里（offset），每次只读新增的部分，一行一行交出去。
// 文件变短或换了一个（inode 变了，比如 agent 整个重写）时从头再读，调用方据此清空统计。
// 只读打开，从不写。

import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const CHUNK = 1024 * 1024;
/** 一行最长多少字符，超过的整行丢掉（不会是我们要的用量行）。 */
const MAX_LINE = 8 * 1024 * 1024;

export class JsonlTail {
  private offset = 0;
  private ino: number | null = null;
  private partial = '';
  private skipping = false;
  private decoder = new StringDecoder('utf8');

  constructor(
    readonly file: string,
    private readonly onLine: (line: string) => void,
    /** 从头重读之前调用（文件被截短或替换）。 */
    private readonly onReset: () => void = () => {},
  ) {}

  /** 读新增的部分。返回是否读到了新内容；文件不存在返回 false。 */
  async poll(): Promise<boolean> {
    let st;
    try {
      st = await stat(this.file);
    } catch {
      return false;
    }
    if ((this.ino !== null && st.ino !== this.ino) || st.size < this.offset) {
      this.offset = 0;
      this.partial = '';
      this.skipping = false;
      this.decoder = new StringDecoder('utf8');
      this.onReset();
    }
    this.ino = st.ino;
    if (st.size === this.offset) return false;
    const fh = await open(this.file, 'r');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      while (this.offset < st.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - this.offset), this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.push(this.decoder.write(buf.subarray(0, bytesRead)));
      }
    } finally {
      await fh.close();
    }
    return true;
  }

  private push(text: string): void {
    let start = 0;
    let nl: number;
    while ((nl = text.indexOf('\n', start)) >= 0) {
      const piece = text.slice(start, nl);
      start = nl + 1;
      if (this.skipping) {
        this.skipping = false;
        this.partial = '';
        continue;
      }
      const line = this.partial ? this.partial + piece : piece;
      this.partial = '';
      if (line) this.emit(line);
    }
    if (start < text.length) {
      if (this.skipping) return;
      this.partial += text.slice(start);
      if (this.partial.length > MAX_LINE) {
        this.partial = '';
        this.skipping = true;
      }
    }
  }

  private emit(line: string): void {
    try {
      this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    } catch {
      // 读取器出错不影响后面的行
    }
  }
}
