// BrowserService 的实现（contracts 0.1.2 · browser.ts），加上主进程里给 Electron 钩子用的两个入口：
// rewriteHeaders（onHeadersReceived）和 resolveFile（agentdeck-file:// 协议）。
// 不 import Electron：打开外部链接、请求、文件系统都从参数传进来，方便单测。和 Electron 的连接在 index.ts。

import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentDeckError, type AbsPath, type BrowserService, type PreparedPage } from '@agentdeck/contracts';
import { relaxSetCookies, stripFrameBlockingHeaders, type ResponseHeaders } from './headers.ts';
import { FileRoots, isLocalFileUrl, pathFromFileUrl, toLocalFileUrl } from './local-files.ts';
import { FrameOriginAllowList, parseUrl } from './origins.ts';

export interface FileStat {
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface BrowserServiceDeps {
  /** Electron shell.openExternal。 */
  openExternal(url: string): Promise<void>;
  /** ping 用。默认 globalThis.fetch。 */
  fetch?: typeof fetch;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileStat>;
  /** ping 等多久算没响应。默认 3000。 */
  pingTimeoutMs?: number;
}

export interface HeadersDetails {
  url: string;
  resourceType: string;
  responseHeaders?: ResponseHeaders;
}

export type FileResolution = { path: string } | { status: 400 | 403 | 404 };

export interface BrowserCore extends BrowserService {
  /**
   * 名单里的本地来源：作为 iframe 加载时去掉 X-Frame-Options 和 frame-ancestors；所有请求的 Set-Cookie 改成
   * SameSite=None; Secure（否则 file:// 的白板里登录态会丢，见 headers.ts）。返回改写后的响应头；不用改时返回 null。
   */
  rewriteHeaders(details: HeadersDetails): ResponseHeaders | null;
  /** agentdeck-file:// 请求 → 要读的真实路径（realpath 之后），或 400 / 403（不在打开过的目录里）/ 404。 */
  resolveFile(url: string): Promise<FileResolution>;
  readonly allowedOrigins: FrameOriginAllowList;
  readonly fileRoots: FileRoots;
}

function invalid(message: string): never {
  throw new AgentDeckError({ code: 'invalid-argument', message });
}

/** 输入是本地文件（绝对路径、file://、agentdeck-file://）时返回路径和 ?、# 后缀；不是返回 null；是但不合法抛错。 */
function localFileTarget(url: string): { path: string; suffix: string } | null {
  if (isAbsolute(url)) return { path: normalize(url), suffix: '' };
  if (!url.startsWith('file:') && !isLocalFileUrl(url)) return null;
  const path = pathFromFileUrl(url);
  if (path === null) invalid(`Not a valid file address: ${url}`);
  const parsed = parseUrl(url);
  return { path, suffix: parsed === null ? '' : parsed.search + parsed.hash };
}

export function createBrowserService(deps: BrowserServiceDeps): BrowserCore {
  const allowedOrigins = new FrameOriginAllowList();
  const fileRoots = new FileRoots();
  const doFetch = deps.fetch ?? globalThis.fetch;
  const pingTimeoutMs = deps.pingTimeoutMs ?? 3000;

  /** 文件还不存在时退回到“目录的 realpath + 文件名”，目录也不存在就用原路径。 */
  async function canonical(path: string): Promise<string> {
    try {
      return await deps.realpath(path);
    } catch {
      try {
        return join(await deps.realpath(dirname(path)), basename(path));
      } catch {
        return normalize(path);
      }
    }
  }

  /** 文件，或带 index.html 的目录 → 真实文件路径；不存在返回 null。 */
  async function existingFile(path: string): Promise<string | null> {
    try {
      const real = await deps.realpath(path);
      const st = await deps.stat(real);
      if (st.isFile()) return real;
      if (st.isDirectory()) {
        const index = await deps.realpath(join(real, 'index.html'));
        if ((await deps.stat(index)).isFile()) return index;
      }
    } catch {
      // 不存在或读不了，按不存在处理
    }
    return null;
  }

  const service: BrowserCore = {
    allowedOrigins,
    fileRoots,

    async prepare(raw: string): Promise<PreparedPage> {
      const url = raw.trim();
      const file = localFileTarget(url);
      if (file !== null) return { src: (await service.fileUrl(file.path)) + file.suffix, mode: 'frame' };
      const parsed = parseUrl(url);
      if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        invalid(`Only http, https and local files can be opened: ${url}`);
      }
      allowedOrigins.add(parsed);
      return { src: parsed.href, mode: 'frame' };
    },

    async fileUrl(path: AbsPath): Promise<string> {
      if (!isAbsolute(path)) invalid(`Not an absolute path: ${path}`);
      fileRoots.addFileDir(await canonical(path));
      return toLocalFileUrl(normalize(path));
    },

    async openExternal(raw: string): Promise<void> {
      const url = raw.trim();
      const file = localFileTarget(url);
      if (file !== null) return deps.openExternal(pathToFileURL(file.path).href + file.suffix);
      const parsed = parseUrl(url);
      if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        invalid(`Only http, https and local files can be opened: ${url}`);
      }
      return deps.openExternal(parsed.href);
    },

    async ping(raw: string): Promise<{ ok: boolean; status: number | null }> {
      const url = raw.trim();
      const file = localFileTarget(url);
      if (file !== null) {
        return (await existingFile(file.path)) === null ? { ok: false, status: 404 } : { ok: true, status: 200 };
      }
      const parsed = parseUrl(url);
      if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        invalid(`Only http and https addresses can be checked: ${url}`);
      }
      // 只要服务回了任何 HTTP 响应（包括 404、500）就算在响应：那时应显示服务自己的页面，而不是出错页。
      try {
        const res = await doFetch(parsed.href, { redirect: 'manual', signal: AbortSignal.timeout(pingTimeoutMs) });
        void res.body?.cancel().catch(() => {});
        return { ok: true, status: res.status };
      } catch {
        return { ok: false, status: null };
      }
    },

    rewriteHeaders(details) {
      if (!allowedOrigins.allows(details.url)) return null;
      const original = details.responseHeaders ?? {};
      const framed = details.resourceType === 'subFrame' ? stripFrameBlockingHeaders(original) : null;
      const cookies = relaxSetCookies(framed ?? original);
      return cookies ?? framed;
    },

    async resolveFile(url) {
      const path = pathFromFileUrl(url);
      if (path === null) return { status: 400 };
      const real = await existingFile(path);
      if (real === null) return { status: 404 };
      return fileRoots.allows(real) ? { path: real } : { status: 403 };
    },
  };
  return service;
}

/** 只留 contracts 里的四个方法，注册到 IPC 上。rewriteHeaders、resolveFile 不能让界面调到。 */
export function publicBrowserService(core: BrowserCore): BrowserService {
  return {
    prepare: (url) => core.prepare(url),
    fileUrl: (path) => core.fileUrl(path),
    openExternal: (url) => core.openExternal(url),
    ping: (url) => core.ping(url),
  };
}
