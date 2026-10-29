// BrowserService 的假实现：不改响应头，只记下哪些来源被放行；ping 的结果可以预设。

import { LOCAL_FILE_SCHEME } from '@agentdeck/contracts';
import type { AbsPath, BrowserService, PreparedPage } from '@agentdeck/contracts';
import { fail } from './util.ts';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

export function isLocalhostUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith('.localhost'));
  } catch {
    return false;
  }
}

export class FakeBrowserService implements BrowserService {
  /** prepare 过的 localhost 来源（真实现会把它们加进响应头改写名单）。 */
  readonly allowedOrigins = new Set<string>();
  /** openExternal 打开过的地址。 */
  readonly opened: string[] = [];
  private readonly reachability = new Map<string, { ok: boolean; status: number | null }>();

  /** 和真实现一样：本地地址用 iframe，外部网站用 webview；opts.mode 为 webview 时本地地址也用 webview。 */
  async prepare(url: string, opts?: { mode?: 'frame' | 'webview' }): Promise<PreparedPage> {
    if (url.startsWith('/')) {
      // 和真实现一样：第一个 ? 或 # 起算后缀（地址栏把 file://…pdf#page=4 转成 …pdf#page=4）
      const cut = url.search(/[?#]/);
      if (cut < 0) return { src: await this.fileUrl(url), mode: 'frame' };
      return { src: (await this.fileUrl(url.slice(0, cut))) + url.slice(cut), mode: 'frame' };
    }
    if (url.startsWith('file://')) return { src: await this.fileUrl(decodeURI(new URL(url).pathname)), mode: 'frame' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail('invalid-argument', `Not a valid address: ${url}`);
    }
    if (!isLocalhostUrl(url) || opts?.mode === 'webview') return { src: url, mode: 'webview' };
    this.allowedOrigins.add(parsed.origin);
    return { src: url, mode: 'frame' };
  }

  async fileUrl(path: AbsPath): Promise<string> {
    if (!path.startsWith('/')) fail('invalid-argument', `Not an absolute path: ${path}`);
    return `${LOCAL_FILE_SCHEME}://${encodeURI(path)}`;
  }

  async openExternal(url: string): Promise<void> {
    this.opened.push(url);
  }

  /** 默认都在响应（200）。用 setReachable 模拟服务没起来。 */
  async ping(url: string): Promise<{ ok: boolean; status: number | null }> {
    return { ...(this.reachability.get(originOf(url)) ?? { ok: true, status: 200 }) };
  }

  /** 按来源设置 ping 结果，例如 setReachable('http://localhost:5173', false)。 */
  setReachable(url: string, ok: boolean, status: number | null = ok ? 200 : null): void {
    this.reachability.set(originOf(url), { ok, status });
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
