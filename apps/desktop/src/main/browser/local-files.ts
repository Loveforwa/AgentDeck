// 本地 HTML 文件 ⇄ agentdeck-file:// 地址，以及“只能读用户打开过的文件所在目录”的检查。
// 纯逻辑，只用 node:path / node:url，不碰文件系统（真实路径由调用方用 realpath 算好再传进来）。
//
// 地址形如 agentdeck-file:///Users/me/report.html。这个协议注册成非 standard：
// Electron 45 实测非 standard 协议的三个斜杠能原样保留、相对路径（style.css、sub/img.svg）能正确解析，
// 页面的 origin 是 "null"（不透明），读不到别的文件；注册成 standard 会把第一段路径当成主机名并转成小写。

import { dirname, isAbsolute, normalize, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCAL_FILE_SCHEME } from '@agentdeck/contracts';

const PREFIX = `${LOCAL_FILE_SCHEME}:`;

export function isLocalFileUrl(url: string): boolean {
  return url.startsWith(PREFIX);
}

/** /Users/me/a b.html → agentdeck-file:///Users/me/a%20b.html。路径必须是绝对路径。 */
export function toLocalFileUrl(path: string): string {
  if (!isAbsolute(path)) throw new Error(`Not an absolute path: ${path}`);
  return PREFIX + pathToFileURL(path).href.slice('file:'.length);
}

/**
 * agentdeck-file:// 或 file:// 地址 → 绝对路径（已去掉 ..、%2e%2e 之类）。
 * 地址不合法（有主机名、编码的斜杠、NUL……）返回 null。查询串和 # 后面的部分忽略。
 */
export function pathFromFileUrl(url: string): string | null {
  let fileUrl: string;
  if (url.startsWith(PREFIX)) fileUrl = 'file:' + url.slice(PREFIX.length);
  else if (url.startsWith('file:')) fileUrl = url;
  else return null;
  try {
    const parsed = new URL(fileUrl);
    if (parsed.host !== '') return null;
    parsed.search = '';
    parsed.hash = '';
    const path = fileURLToPath(parsed);
    if (path.includes('\0')) return null;
    return normalize(path);
  } catch {
    return null;
  }
}

/** target 是否就是 root 或在 root 下面。两个都要是绝对路径。 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/** 用户打开过的本地文件所在的目录。只有这些目录和它们的子目录能通过 agentdeck-file:// 读。 */
export class FileRoots {
  private readonly roots = new Set<string>();

  /** 加入文件所在的目录。传进来的应是 realpath 之后的路径。 */
  addFileDir(filePath: string): void {
    this.roots.add(dirname(normalize(filePath)));
  }

  /** realPath 是请求的文件 realpath 之后的路径，这样符号链接指到外面也会被拦住。 */
  allows(realPath: string): boolean {
    for (const root of this.roots) if (isInside(root, realPath)) return true;
    return false;
  }

  list(): string[] {
    return [...this.roots];
  }
}
