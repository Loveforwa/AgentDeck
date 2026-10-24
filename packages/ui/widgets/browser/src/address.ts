// 地址栏的输入和显示。纯函数。
// 只接受 http、https 和本地文件（绝对路径、file://）；localhost:3000 这种不带协议的补 http://，其他主机补 https://。

import { LOCAL_FILE_SCHEME } from '@agentdeck/contracts';

export type AddressResult = { ok: true; url: string } | { ok: false; message: string };

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
/** 主机[:端口][/路径]，主机可以是 IPv6 字面量。 */
const HOST_ONLY = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d+)?([/?#].*)?$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.localhost)$/i;

export const ADDRESS_HINT = 'Only http, https and local file addresses can be opened.';

/** 地址栏里敲的东西 → 要打开的地址。本地文件返回绝对路径（file:// 也转成路径）。本地主机和 IP 补 http://。 */
export function normalizeAddress(input: string): AddressResult {
  const text = input.trim();
  if (text === '') return { ok: false, message: 'Enter an address.' };
  if (text.startsWith('/')) return { ok: true, url: text };
  if (/^file:/i.test(text) || text.startsWith(`${LOCAL_FILE_SCHEME}:`)) {
    const path = pathFromFileHref(text);
    return path === null ? { ok: false, message: ADDRESS_HINT } : { ok: true, url: path };
  }
  const host = HOST_ONLY.exec(text);
  if (host !== null && !/^\d+$/.test(text) && (host[1]?.includes('.') || LOCAL_HOST.test(host[1] ?? '') || host[2])) {
    const name = host[1] ?? '';
    const scheme = LOCAL_HOST.test(name) || /^\d+(\.\d+){3}$/.test(name) ? 'http' : 'https';
    return parseHttp(`${scheme}://${text}`);
  }
  if (SCHEME.test(text)) return parseHttp(text);
  return { ok: false, message: ADDRESS_HINT };
}

function parseHttp(text: string): AddressResult {
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, message: ADDRESS_HINT };
    return { ok: true, url: url.href };
  } catch {
    return { ok: false, message: ADDRESS_HINT };
  }
}

/** file:// 或 agentdeck-file:// → 绝对路径（? 和 # 原样留在后面）。不合法返回 null。 */
export function pathFromFileHref(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.host !== '' || !url.pathname.startsWith('/')) return null;
    return decodeURIComponent(url.pathname) + url.search + url.hash;
  } catch {
    return null;
  }
}

/** 本地文件，或 localhost / 127.0.0.1 / [::1] / *.localhost 的地址。 */
export function isLocalAddress(url: string): boolean {
  if (isFileAddress(url)) return true;
  try {
    return LOCAL_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function isFileAddress(url: string): boolean {
  return url.startsWith('/');
}

/** iframe 里报上来的地址 → 存进 data.url、显示在地址栏里的形式。本地文件用路径。 */
export function addressFromHref(href: string): string {
  if (href.startsWith(`${LOCAL_FILE_SCHEME}:`) || href.startsWith('file:')) return pathFromFileHref(href) ?? href;
  return href;
}

/** 不在编辑时地址栏显示的样子：去掉 http://，只有根路径时去掉末尾的 /。 */
export function displayAddress(url: string): string {
  if (!url.startsWith('http://')) return url;
  const rest = url.slice('http://'.length);
  return rest.endsWith('/') && rest.indexOf('/') === rest.length - 1 ? rest.slice(0, -1) : rest;
}

/**
 * 白板开网页窗口时的 reuseKey：http(s) 用 origin，本地文件用路径。
 * 终端里点 localhost 链接时，同一个 origin 已经开着就复用那个窗口（U2）。
 */
export function browserReuseKey(url: string): string {
  if (isFileAddress(url)) return url.replace(/[?#].*$/, '');
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
