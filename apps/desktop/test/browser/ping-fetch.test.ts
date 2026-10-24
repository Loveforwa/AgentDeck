import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { pingFetch, type PingRequest } from '../../src/main/browser/ping-fetch.ts';
import { createBrowserService } from '../../src/main/browser/service.ts';

/** 假的 net.request：end() 之后按 script 发事件。 */
function fakeRequest(script: (req: EventEmitter) => void) {
  const made: { url: string; aborted: boolean }[] = [];
  const factory = (opts: { url: string }) => {
    const req = new EventEmitter() as EventEmitter & PingRequest;
    const record = { url: opts.url, aborted: false };
    made.push(record);
    req.abort = () => {
      record.aborted = true;
    };
    req.end = () => queueMicrotask(() => script(req));
    return req;
  };
  return { factory, made };
}

const neverFetch = (() => Promise.reject(new Error('fallback used'))) as typeof fetch;

describe('pingFetch (IS-43: net.fetch throws on redirect: manual)', () => {
  it('a redirect counts as a response and is not followed', async () => {
    const { factory, made } = fakeRequest((req) => req.emit('redirect', 301, 'GET', 'https://www.google.com/'));
    const res = await pingFetch(factory, neverFetch)('https://google.com/', { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(made).toEqual([{ url: 'https://google.com/', aborted: true }]);
  });

  it('passes through the status of a normal response, including errors from the server', async () => {
    const { factory } = fakeRequest((req) => req.emit('response', { statusCode: 404 }));
    expect((await pingFetch(factory, neverFetch)('http://localhost:5173/x', { redirect: 'manual' })).status).toBe(404);
  });

  it('rejects on network errors and on abort', async () => {
    const failing = fakeRequest((req) => req.emit('error', new Error('net::ERR_CONNECTION_REFUSED')));
    await expect(pingFetch(failing.factory, neverFetch)('http://localhost:5349/', { redirect: 'manual' })).rejects.toThrow('REFUSED');

    const silent = fakeRequest(() => {});
    const ac = new AbortController();
    const pending = pingFetch(silent.factory, neverFetch)('http://localhost:5349/', { redirect: 'manual', signal: ac.signal });
    ac.abort(new Error('timeout'));
    await expect(pending).rejects.toThrow('timeout');
    expect(silent.made[0]?.aborted).toBe(true);
  });

  it('anything without redirect: manual goes to the fallback', async () => {
    const fallback = vi.fn(async () => new Response(null, { status: 204 }));
    const { factory, made } = fakeRequest(() => {});
    expect((await pingFetch(factory, fallback as typeof fetch)('https://example.com/')).status).toBe(204);
    expect(made).toEqual([]);
  });

  it('wired into the browser service: a redirecting site is reachable', async () => {
    const { factory } = fakeRequest((req) => req.emit('redirect', 302, 'GET', 'http://localhost:3000/login'));
    const core = createBrowserService({
      openExternal: async () => {},
      fetch: pingFetch(factory, neverFetch),
      realpath: async (p) => p,
      stat: async () => ({ isFile: () => false, isDirectory: () => false }),
    });
    expect(await core.ping('http://localhost:3000/')).toEqual({ ok: true, status: 302 });
  });
});
