// 从 markdown 里读出代码引用（M15 · DC0）。纯函数，界面（文档窗口画下划线和状态）和服务（doc-service 核对）共用一份，
// 同 effectiveSkillSelection 的做法。写法见 docs.ts 的 CodeAnchor 和设计画布“文档”页 D1 第 1 节。
//
// 不算的：围栏代码块（``` 或 ~~~）里的；网址里的（https://host/a.ts:3、[text](url) 的 url）；没有扩展名的（node:fs、10:42）；
// 不带斜杠、扩展名像域名的（example.com:8080）。只写路径、不带行号的也不算（除了 path (new)）。

import type { CodeRef } from './docs.ts';

/** 路径：可以是绝对路径或 ./ ../ 开头，最后一段要有字母开头的扩展名。 */
const PATH = String.raw`(?:\/|\.{1,2}\/)?(?:[\w.+-]+\/)*[\w+-][\w.+-]*\.[A-Za-z][A-Za-z0-9]*`;

/**
 * 一处引用：path 后面接 @rev:行、:行、:起-止、:行:列、#L起、#L起-L止、#L起-止，或 “ (new)”。
 * 前面不能紧挨着路径字符（不在一个词的中间）；开头可以有 claude 的 @。
 */
const REF = new RegExp(
  String.raw`(?<![\w./@+-])@?(${PATH})(?:(?:@([\w.-]+))?:(\d+)(?:-(\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?|( \(new\)))(?![\w/-])`,
  'g',
);

/** 带来源前缀的外部源码：owner/repo ref (YYYY-MM-DD) path[:行[-止]]。 */
const EXTERNAL = new RegExp(
  String.raw`(?<![\w./-])([\w.-]+\/[\w.-]+) ([\w./-]+) \((\d{4}-\d{2}-\d{2})\) (${PATH})(?::(\d+)(?:-(\d+))?)?`,
  'g',
);

/** 网址（带 scheme 的整段）和 markdown 链接的地址部分，先遮掉，免得里面的 a.ts:3 被认成引用。 */
const URLISH = /[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+|\]\([^)\s]*\)/gi;

/** 围栏代码块的开头和结尾（最多缩进 3 个空格）。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** 紧跟在后面的符号：可以先有一个收尾的反引号，再有空白，再是 `Symbol`（可以带 ()）。 */
const SYMBOL_AFTER = /^`?[ \t]*`([A-Za-z_$][\w$.]*)(?:\(\))?`/;

/** 不带斜杠的“路径”扩展名是这些时，多半是域名加端口，不算。 */
const HOST_LIKE = new Set(['com', 'org', 'net', 'io', 'dev', 'ai', 'app', 'sh', 'co', 'local', 'internal', 'localhost', 'test']);

function mask(text: string, re: RegExp): string {
  return text.replace(re, (m) => ' '.repeat(m.length));
}

function lineNumber(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

/** 读出 markdown 里的代码引用，按在文档里的先后排。 */
export function parseCodeRefs(markdown: string): CodeRef[] {
  const refs: CodeRef[] = [];
  let offset = 0;
  let fence: string | null = null;
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineStart = offset;
    offset += line.length + 1;

    const f = FENCE.exec(line);
    if (fence !== null) {
      if (f?.[1] !== undefined && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f?.[1] !== undefined) {
      fence = f[1];
      continue;
    }

    let masked = mask(line, URLISH);

    for (const m of masked.matchAll(EXTERNAL)) {
      const [whole, repo, rev, date, path, start, end] = m;
      if (path === undefined) continue;
      const from = lineStart + (m.index ?? 0);
      const ref: CodeRef = {
        path,
        raw: whole,
        at: { from, to: from + whole.length, line: i + 1 },
        kind: 'external',
        source: `${repo} ${rev} (${date})`,
      };
      const s = lineNumber(start);
      if (s !== undefined) ref.start = s;
      const e = lineNumber(end);
      if (e !== undefined) ref.end = e;
      refs.push(ref);
    }
    masked = mask(masked, EXTERNAL);

    for (const m of masked.matchAll(REF)) {
      const [whole, path, rev, colStart, colEnd, hashStart, hashEnd, isNew] = m;
      if (path === undefined) continue;
      if (!path.includes('/')) {
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        if (HOST_LIKE.has(ext)) continue;
      }
      const lead = whole.startsWith('@') ? 1 : 0;
      const raw = whole.slice(lead);
      const from = lineStart + (m.index ?? 0) + lead;
      const ref: CodeRef = { path, raw, at: { from, to: from + raw.length, line: i + 1 }, kind: isNew ? 'new' : 'repo' };
      const start = lineNumber(colStart ?? hashStart);
      if (start !== undefined) ref.start = start;
      const end = lineNumber(colEnd ?? hashEnd);
      if (end !== undefined) ref.end = end;
      if (rev !== undefined) ref.rev = rev;
      const symbol = SYMBOL_AFTER.exec(line.slice((m.index ?? 0) + whole.length))?.[1];
      if (symbol !== undefined) ref.symbol = symbol;
      refs.push(ref);
    }
  }
  return refs.sort((a, b) => a.at.from - b.at.from);
}
