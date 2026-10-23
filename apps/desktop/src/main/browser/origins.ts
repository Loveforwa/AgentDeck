// 哪些地址算“本地服务”，以及响应头改写名单。纯逻辑，不依赖 Electron。

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/** http(s) 且主机是 localhost、127.0.0.1、[::1]、0.0.0.0 或 *.localhost。 */
export function isLocalHttpUrl(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOCAL_HOSTNAMES.has(url.hostname) || url.hostname.endsWith('.localhost');
}

export function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * 响应头改写名单：只放 prepare 过的本地来源（scheme + host + port）。
 * 名单外的网站，包括其他端口的 localhost，响应头都不动。
 */
export class FrameOriginAllowList {
  private readonly origins = new Set<string>();

  /** 本地来源加进名单并返回 true；不是本地 http(s) 地址时不加，返回 false。 */
  add(url: URL): boolean {
    if (!isLocalHttpUrl(url)) return false;
    this.origins.add(url.origin);
    return true;
  }

  allows(rawUrl: string): boolean {
    const url = parseUrl(rawUrl);
    return url !== null && isLocalHttpUrl(url) && this.origins.has(url.origin);
  }

  list(): string[] {
    return [...this.origins];
  }
}
