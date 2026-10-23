// 终端里可点的地址：localhost 网址和“文件:行号”。给 xterm 的 link provider 用（在屏幕上画下划线、单击打开）。
// 规则是 packages/port-watch/src/links.ts 的副本（界面包不能 import 服务包），两边测试用同一份例子
// （packages/port-watch/test/link-cases.json）。改规则时两边一起改。

import type { TerminalLink } from '@agentdeck/contracts';

/** http(s)://localhost、127.0.0.1、0.0.0.0、[::1]，或者不带协议的 localhost:端口。 */
const LOCAL_URL = /\b(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d{1,5})?((?:[/?#][^\s"'<>`{}|\\^]*)?)/gi;

/**
 * 文件:行号（:列）、文件(行,列)（tsc）、Python 的 File "x.py", line 3。
 * 文件名要带扩展名（字母开头），免得 “Error:12”“v1.2:3” 被认成文件。
 */
const PATH = String.raw`((?:~|\.{1,2})?(?:\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][\w]{0,9})`;
const FILE_COLON = new RegExp(String.raw`(?:^|[\s('"\[\`=:])${PATH}:(\d+)(?::(\d+))?(?![\w/])`, 'g');
const FILE_PAREN = new RegExp(String.raw`(?:^|[\s('"\[\`=])${PATH}\((\d+),(\d+)\)`, 'g');
const PYTHON = /File "([^"]+)", line (\d+)/g;

/** 看起来是域名而不是文件的扩展名（example.com:8080）。 */
const NOT_FILE_EXT = new Set(['com', 'org', 'net', 'io', 'dev', 'app', 'ai', 'co', 'local', 'localhost', 'me', 'xyz', 'cn', 'uk', 'de', 'jp', 'internal']);

/** 一处匹配：在这一行里的位置（UTF-16 下标，end 不含）和识别出的链接。 */
export interface LinkMatch {
  start: number;
  end: number;
  link: TerminalLink;
}

export function findLinks(line: string): TerminalLink[] {
  return findLinkMatches(line).map((m) => m.link);
}

export function findLinkMatches(line: string): LinkMatch[] {
  const found: LinkMatch[] = [];
  // 网址部分先找出来并盖掉，免得 “http://localhost:3000/a.ts:3” 再被当成文件
  let masked = line;
  for (const m of line.matchAll(LOCAL_URL)) {
    const local = normalizeLocalUrl(m);
    if (local === null) continue;
    found.push({ start: m.index, end: m.index + local.length, link: { kind: 'localhost', url: local.url } });
    masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index + m[0].length);
  }
  // 其余网址（https://github.com/...）也盖掉，里面的 “a.ts:3” 不算文件
  masked = masked.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, (s) => ' '.repeat(s.length));

  const add = (m: RegExpMatchArray, path: string, line: string, column?: string) => {
    if (!path || /^\d/.test(path)) return;
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    if (NOT_FILE_EXT.has(ext)) return;
    const link: TerminalLink = { kind: 'file', path, line: Number(line) };
    if (column !== undefined) link.column = Number(column);
    const start = m.index! + m[0].indexOf(path);
    found.push({ start, end: m.index! + m[0].length, link });
  };
  for (const m of masked.matchAll(FILE_COLON)) add(m, m[1]!, m[2]!, m[3]);
  for (const m of masked.matchAll(FILE_PAREN)) add(m, m[1]!, m[2]!, m[3]);
  for (const m of masked.matchAll(PYTHON)) add(m, m[1]!, m[2]!);
  return found.sort((a, b) => a.start - b.start);
}

/** 返回规范化的地址和原文里实际算进链接的长度（去掉了结尾的标点）。 */
function normalizeLocalUrl(m: RegExpMatchArray): { url: string; length: number } | null {
  const [whole, scheme, host = '', port, rest = ''] = m;
  // 不带协议时一定要有端口（“localhost” 这个词本身不算）
  if (!scheme && !port) return null;
  // 0.0.0.0 和 [::] 是“监听所有地址”，浏览器里打不开，换成 localhost
  const h = host === '0.0.0.0' || host === '[::]' ? 'localhost' : host.toLowerCase();
  let path = rest.replace(/[.,;:!?]+$/, '');
  // 结尾多出来的右括号（“(see http://localhost:3000)”）
  while (path.endsWith(')') && count(path, '(') < count(path, ')')) path = path.slice(0, -1);
  while (path.endsWith(']') && count(path, '[') < count(path, ']')) path = path.slice(0, -1);
  return { url: `${scheme ? scheme.toLowerCase() : 'http://'}${h}${port ?? ''}${path || '/'}`, length: whole.length - (rest.length - path.length) };
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}
