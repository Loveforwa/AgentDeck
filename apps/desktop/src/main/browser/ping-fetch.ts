// ping 用的 fetch。不能直接用 net.fetch：Electron 45 的 net.fetch 在 redirect: 'manual' 时遇到任何跳转都抛
// “Redirect was cancelled”（2026-10-24 实测 https://google.com/ → 301），于是所有会跳转的地址（google.com、
// 把 / 跳到 /login 的 dev server）都被当成“没响应”（IS-43）。这里改用 net.request：收到跳转或响应头就算有响应，
// 不跟过去，也不读正文。和 net.fetch 一样走 session 的网络栈（系统代理）。
// 不 import Electron，net.request 从参数传进来，方便单测。

/** 用到的 net.request 返回值（Electron ClientRequest）的部分。 */
export interface PingRequest {
  on(event: 'redirect', cb: (statusCode: number) => void): unknown;
  on(event: 'response', cb: (response: { statusCode: number }) => void): unknown;
  on(event: 'error', cb: (error: Error) => void): unknown;
  abort(): void;
  end(): void;
}

export type RequestFactory = (options: { url: string; method: 'GET'; redirect: 'manual' }) => PingRequest;

/** 只认 service.ping 用到的参数：redirect: 'manual' 和 signal。其他情况交给 fallback（net.fetch）。 */
export function pingFetch(request: RequestFactory, fallback: typeof fetch): typeof fetch {
  return (input, init) => {
    if (init?.redirect !== 'manual') return fallback(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const signal = init.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const req = request({ url, method: 'GET', redirect: 'manual' });
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const answered = (status: number) =>
        settle(() => {
          req.abort();
          // Response 只接受 200–599；1xx 不会单独到这里
          resolve(new Response(null, { status: Math.min(Math.max(status, 200), 599) }));
        });
      const onAbort = () =>
        settle(() => {
          req.abort();
          reject(signal?.reason);
        });
      signal?.addEventListener('abort', onAbort);
      req.on('redirect', (status) => answered(status));
      req.on('response', (res) => answered(res.statusCode));
      req.on('error', (error) => settle(() => reject(error)));
      req.end();
    });
  };
}
