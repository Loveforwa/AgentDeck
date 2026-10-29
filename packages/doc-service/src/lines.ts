// 代码锚点的核心算法，都是纯函数：按 hunk 挪行号、在新文件里找原来那几行、找符号、两份文本的行级 diff。
// 设计见设计画布“文档”页 D1 第 2 节和 DR-94。

import type { LineMapHunk } from '@agentdeck/contracts';

/** 按 git 的算法拆行：结尾的换行不多出一个空行。 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * 旧文件第 x 行在新文件里的位置。x 落在被改或被删的段里时：side 'start' 给这段新内容的第一行，'end' 给最后一行
 * （整段被删时 start 是删除点的下一行、end 是上一行，于是 end < start）。hunk 按 oldStart 排好（git 的输出就是）。
 */
export function mapLine(hunks: readonly LineMapHunk[], x: number, side: 'start' | 'end'): number {
  let delta = 0;
  for (const h of hunks) {
    if (h.oldLines === 0) {
      // 插在旧文件第 oldStart 行之后
      if (h.oldStart < x) {
        delta += h.newLines;
        continue;
      }
      break;
    }
    const last = h.oldStart + h.oldLines - 1;
    if (last < x) {
      delta += h.newLines - h.oldLines;
      continue;
    }
    if (h.oldStart > x) break;
    if (side === 'start') return h.newLines > 0 ? h.newStart : h.newStart + 1;
    return h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart;
  }
  return x + delta;
}

/** 旧文件的 s–e 行有没有被改过：有 hunk 删或改了其中的行，或者在这几行中间插了行。 */
export function touches(hunks: readonly LineMapHunk[], s: number, e: number): boolean {
  return hunks.some((h) =>
    h.oldLines === 0 ? h.oldStart >= s && h.oldStart < e : h.oldStart <= e && h.oldStart + h.oldLines - 1 >= s,
  );
}

/** 值得拿来找的行：不是空行、不是只有括号和标点（这种行到处都有，找到了也说明不了什么）。同第 11 点的 drift.py。 */
export function interesting(line: string): boolean {
  const t = line.trim();
  return t.length > 3 && !/^[{}()[\];,\s]*$/.test(t);
}

const same = (a: string, b: string) => a.trimEnd() === b.trimEnd();

/** 在 lines 里找和 block 一模一样（忽略行尾空白）的一段，返回离 near 最近的那段的起始行（1 起）。block 里没有值得找的行时不找。 */
export function findBlock(lines: readonly string[], block: readonly string[], near: number): number | null {
  if (block.length === 0 || !block.some(interesting)) return null;
  let best: number | null = null;
  for (let i = 0; i + block.length <= lines.length; i += 1) {
    let k = 0;
    while (k < block.length && same(lines[i + k]!, block[k]!)) k += 1;
    if (k < block.length) continue;
    const at = i + 1;
    if (best === null || Math.abs(at - near) < Math.abs(best - near)) best = at;
  }
  return best;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 符号在 from–to 行（含前后各 radius 行）里出现的第一行；带点的符号（a.b）也认最后一段。找不到返回 null。 */
export function findSymbol(lines: readonly string[], symbol: string, from: number, to: number, radius = 20): number | null {
  const names = [symbol];
  const last = symbol.split('.').pop();
  if (last && last !== symbol) names.push(last);
  const lo = Math.max(1, Math.min(from, to) - radius);
  const hi = Math.min(lines.length, Math.max(from, to) + radius);
  for (const name of names) {
    const re = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
    for (let n = lo; n <= hi; n += 1) if (re.test(lines[n - 1]!)) return n;
  }
  return null;
}

/** 核对一处引用（旧文件的 s–e 行）的结果。same：内容没变（可能挪了）；changed：改过；gone：这几行没了或符号找不到。 */
export interface Classified {
  kind: 'same' | 'changed' | 'gone';
  /** 新文件里的位置。 */
  start: number;
  end: number;
  detail?: string;
}

/**
 * base 是基准版本的文件，now 是现在的，hunks 是 base → now 的行号映射。1 ≤ s ≤ e ≤ base.length 由调用方保证。
 * 先按 hunk 挪；碰到 hunk 的再在新文件里找一模一样的一段（git 的对齐有时把没变的行也算进 hunk）；
 * 都不行就是改过了；整段删掉、符号也找不到时是 gone。有符号时最后还要在新范围 ±20 行里找得到它。
 */
export function classify(
  base: readonly string[],
  now: readonly string[],
  hunks: readonly LineMapHunk[],
  s: number,
  e: number,
  symbol?: string,
): Classified {
  const len = e - s + 1;
  const block = base.slice(s - 1, e);
  const ns = Math.min(mapLine(hunks, s, 'start'), now.length + 1);
  const ne = Math.min(mapLine(hunks, e, 'end'), now.length);

  const withSymbol = (c: Classified) => checkSymbol(now, c, symbol);

  if (!touches(hunks, s, e) && ns + len - 1 <= now.length && block.every((l, i) => same(l, now[ns - 1 + i]!)))
    return withSymbol({ kind: 'same', start: ns, end: ns + len - 1 });

  const at = findBlock(now, block, ns);
  if (at !== null) return withSymbol({ kind: 'same', start: at, end: at + len - 1 });

  if (ne < ns) {
    // 整段删掉了：符号还在附近就算改过（指到符号那一行），否则找不到了
    const sym = symbol === undefined ? null : findSymbol(now, symbol, ns, ns);
    if (sym === null) return { kind: 'gone', start: ns, end: ns, detail: 'These lines were deleted' };
    return { kind: 'changed', start: sym, end: Math.min(now.length, sym + len - 1) };
  }
  if (symbol !== undefined && findSymbol(now, symbol, ns, ne) === null)
    return { kind: 'gone', start: ns, end: ne, detail: `${symbol} isn’t near these lines any more` };
  return { kind: 'changed', start: ns, end: ne };
}

/** 有符号时，内容没变的结果还要在新范围 ±20 行里找得到它，找不到算 gone。 */
export function checkSymbol(now: readonly string[], c: Classified, symbol: string | undefined): Classified {
  if (symbol === undefined || c.kind === 'gone') return c;
  if (findSymbol(now, symbol, c.start, c.end) !== null) return c;
  return { kind: 'gone', start: c.start, end: c.end, detail: `${symbol} isn’t near these lines any more` };
}

/** 从新文件的行数和 hunk 倒推旧文件有几行。 */
export function oldLength(newLength: number, hunks: readonly LineMapHunk[]): number {
  return hunks.reduce((n, h) => n - (h.newLines - h.oldLines), newLength);
}

/** 一段改动（0 起，半开）。 */
interface Gap {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** 超过这么多处改动就不细算，整段当成换掉了（Myers 的回溯记录是 D² 级的）。 */
const MAX_EDITS = 2000;

/**
 * 两份文本的行级 diff（Myers），输出和 git diff -U0 的 @@ 头一样的 hunk。给“核对过”的基准用：那时的文件全文存在库里，
 * 不一定在 git 的对象库里，没法交给 git diff。
 */
export function diffLines(a: readonly string[], b: readonly string[]): LineMapHunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (A.length === 0 && B.length === 0) return [];
  const gaps = myersGaps(A, B) ?? [{ a0: 0, a1: A.length, b0: 0, b1: B.length }];
  return gaps.map((g) => {
    const oldLines = g.a1 - g.a0;
    const newLines = g.b1 - g.b0;
    return {
      oldStart: pre + g.a0 + (oldLines > 0 ? 1 : 0),
      oldLines,
      newStart: pre + g.b0 + (newLines > 0 ? 1 : 0),
      newLines,
    };
  });
}

function myersGaps(A: readonly string[], B: readonly string[]): Gap[] | null {
  const N = A.length;
  const M = B.length;
  if (N === 0 || M === 0) return null;
  const MAX = N + M;
  const off = MAX + 1;
  const v = new Int32Array(2 * MAX + 3);
  const trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= MAX && !done; d += 1) {
    if (d > MAX_EDITS) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        done = true;
        break;
      }
    }
  }
  // 回溯出所有对上的行
  const matches: [number, number][] = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const snap = trace[d]!;
    const at = (k: number) => snap[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  matches.reverse();
  const gaps: Gap[] = [];
  let pa = 0;
  let pb = 0;
  for (const [i, j] of [...matches, [N, M] as [number, number]]) {
    if (i > pa || j > pb) gaps.push({ a0: pa, a1: i, b0: pb, b1: j });
    pa = i + 1;
    pb = j + 1;
  }
  return gaps;
}
