import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAgentDeckErrorData } from '@agentdeck/contracts';
import { BOARD_FRAME_NAME_PREFIX, BRIDGE_SCRIPT, isBoardFrame } from '../../src/main/browser/bridge.ts';
import { createBrowserService, publicBrowserService } from '../../src/main/browser/service.ts';

let dir: string;
let server: Server;
let port: number;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'agentdeck-browser-')));
  await mkdir(join(dir, 'site', 'docs'), { recursive: true });
  await writeFile(join(dir, 'site', 'index.html'), '<h1>hi</h1>');
  await writeFile(join(dir, 'site', 'docs', 'index.html'), '<h1>docs</h1>');
  await writeFile(join(dir, 'secret.txt'), 'secret');
  await symlink(join(dir, 'secret.txt'), join(dir, 'site', 'link.txt'));
  server = createServer((req, res) => {
    res.statusCode = req.url === '/missing' ? 404 : 200;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

function service() {
  const openExternal = vi.fn(async (_url: string) => {});
  return { openExternal, core: createBrowserService({ openExternal, realpath, stat, pingTimeoutMs: 1000 }) };
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('prepare', () => {
  it('returns localhost urls unchanged and adds the origin to the allow list', async () => {
    const { core } = service();
    expect(await core.prepare(' http://localhost:3000/login ')).toEqual({ src: 'http://localhost:3000/login', mode: 'frame' });
    expect(core.allowedOrigins.list()).toEqual(['http://localhost:3000']);
  });

  it('opens other sites in a webview and does not allow-list them (IS-44)', async () => {
    const { core } = service();
    expect(await core.prepare('https://example.com/')).toEqual({ src: 'https://example.com/', mode: 'webview' });
    expect(await core.prepare('http://192.168.1.5:8080/')).toEqual({ src: 'http://192.168.1.5:8080/', mode: 'webview' });
    expect(core.allowedOrigins.list()).toEqual([]);
  });

  it('a local address can be asked for as a webview; local files are always frames', async () => {
    const { core } = service();
    expect(await core.prepare('http://localhost:3000/', { mode: 'webview' })).toEqual({ src: 'http://localhost:3000/', mode: 'webview' });
    expect(core.allowedOrigins.list()).toEqual([]);
    expect((await core.prepare('/tmp/report.html', { mode: 'webview' })).mode).toBe('frame');
  });

  it('maps local files to agentdeck-file:// and keeps ? and #', async () => {
    const { core } = service();
    const file = join(dir, 'site', 'index.html');
    expect((await core.prepare(file)).src).toBe(`agentdeck-file://${file}`);
    expect((await core.prepare(`file://${file}#top`)).src).toBe(`agentdeck-file://${file}#top`);
    // IS-124：地址栏存的是路径加后缀（…pdf#page=4），# 和 ? 不算文件名
    expect((await core.prepare(`${file}#page=4`)).src).toBe(`agentdeck-file://${file}#page=4`);
    expect((await core.prepare(`${file}?r=2#page=5`)).src).toBe(`agentdeck-file://${file}?r=2#page=5`);
    expect(core.fileRoots.list()).toEqual([join(dir, 'site')]);
  });

  it('rejects other schemes with invalid-argument', async () => {
    const { core } = service();
    for (const url of ['javascript:alert(1)', 'ftp://localhost/', 'localhost:3000', 'not a url']) {
      const err = await errorOf(core.prepare(url));
      expect(isAgentDeckErrorData(err) && err.code, url).toBe('invalid-argument');
    }
  });
});

describe('fileUrl and resolveFile', () => {
  it('serves files inside the opened directory', async () => {
    const { core } = service();
    const url = await core.fileUrl(join(dir, 'site', 'index.html'));
    expect(await core.resolveFile(url)).toEqual({ path: join(dir, 'site', 'index.html') });
    expect(await core.resolveFile(url.replace('index.html', 'docs/'))).toEqual({
      path: join(dir, 'site', 'docs', 'index.html'),
    });
  });

  it('blocks traversal, symlinks pointing outside and unopened directories', async () => {
    const { core } = service();
    const url = await core.fileUrl(join(dir, 'site', 'index.html'));
    expect(await core.resolveFile(url.replace('index.html', '../secret.txt'))).toEqual({ status: 403 });
    expect(await core.resolveFile(url.replace('index.html', '%2e%2e/secret.txt'))).toEqual({ status: 403 });
    expect(await core.resolveFile(url.replace('index.html', 'link.txt'))).toEqual({ status: 403 });
    expect(await core.resolveFile('agentdeck-file:///etc/hosts')).toEqual({ status: 403 });
    expect(await core.resolveFile('agentdeck-file://host/etc/hosts')).toEqual({ status: 400 });
  });

  it('returns 404 for missing files', async () => {
    const { core } = service();
    const url = await core.fileUrl(join(dir, 'site', 'gone.html'));
    expect(await core.resolveFile(url)).toEqual({ status: 404 });
  });

  it('nothing is readable before a file was opened', async () => {
    const { core } = service();
    expect(await core.resolveFile(`agentdeck-file://${join(dir, 'site', 'index.html')}`)).toEqual({ status: 403 });
  });

  it('rejects relative paths', async () => {
    const { core } = service();
    const err = await errorOf(core.fileUrl('site/index.html'));
    expect(isAgentDeckErrorData(err) && err.code).toBe('invalid-argument');
  });
});

describe('ping', () => {
  it('ok for any HTTP response, including 404', async () => {
    const { core } = service();
    expect(await core.ping(`http://127.0.0.1:${port}/`)).toEqual({ ok: true, status: 200 });
    expect(await core.ping(`http://127.0.0.1:${port}/missing`)).toEqual({ ok: true, status: 404 });
  });

  it('not ok when nothing listens', async () => {
    const { core } = service();
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const free = (closed.address() as AddressInfo).port;
    closed.close();
    expect(await core.ping(`http://127.0.0.1:${free}/`)).toEqual({ ok: false, status: null });
  });

  it('checks local files by existence', async () => {
    const { core } = service();
    expect(await core.ping(join(dir, 'site', 'index.html'))).toEqual({ ok: true, status: 200 });
    expect(await core.ping(`agentdeck-file://${join(dir, 'site', 'gone.html')}`)).toEqual({ ok: false, status: 404 });
    // IS-124：路径后面的 #page=N 不当成文件名
    expect(await core.ping(`${join(dir, 'site', 'index.html')}#page=4`)).toEqual({ ok: true, status: 200 });
  });
});

describe('openExternal', () => {
  it('opens http(s) urls and turns local files into file:// urls', async () => {
    const { core, openExternal } = service();
    await core.openExternal('http://localhost:3000/a');
    await core.openExternal(`agentdeck-file://${join(dir, 'site', 'index.html')}`);
    await core.openExternal('/tmp/a b.html');
    expect(openExternal.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:3000/a',
      `file://${join(dir, 'site', 'index.html')}`,
      'file:///tmp/a%20b.html',
    ]);
  });

  it('refuses other schemes', async () => {
    const { core, openExternal } = service();
    const err = await errorOf(core.openExternal('javascript:alert(1)'));
    expect(isAgentDeckErrorData(err) && err.code).toBe('invalid-argument');
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('rewriteHeaders', () => {
  const blocking = {
    'X-Frame-Options': ['DENY'],
    'Content-Security-Policy': ["default-src 'self'; frame-ancestors 'none'"],
    'Set-Cookie': ['sid=1; SameSite=Lax'],
  };

  it('rewrites frames from allow-listed origins', async () => {
    const { core } = service();
    await core.prepare('http://localhost:3000/');
    expect(
      core.rewriteHeaders({ url: 'http://localhost:3000/login', resourceType: 'subFrame', responseHeaders: blocking }),
    ).toEqual({
      'Content-Security-Policy': ["default-src 'self'"],
      'Set-Cookie': ['sid=1; SameSite=None; Secure'],
    });
  });

  it('only relaxes cookies for non-frame requests from allow-listed origins', async () => {
    const { core } = service();
    await core.prepare('http://localhost:3000/');
    expect(
      core.rewriteHeaders({ url: 'http://localhost:3000/api', resourceType: 'xhr', responseHeaders: blocking }),
    ).toEqual({ ...blocking, 'Set-Cookie': ['sid=1; SameSite=None; Secure'] });
  });

  it('leaves other origins alone', async () => {
    const { core } = service();
    await core.prepare('http://localhost:3000/');
    for (const url of ['http://localhost:3001/', 'https://example.com/', 'http://127.0.0.1:3000/']) {
      expect(core.rewriteHeaders({ url, resourceType: 'subFrame', responseHeaders: blocking }), url).toBeNull();
    }
  });

  it('returns null when an allow-listed response needs no change', async () => {
    const { core } = service();
    await core.prepare('http://localhost:3000/');
    expect(
      core.rewriteHeaders({ url: 'http://localhost:3000/', resourceType: 'subFrame', responseHeaders: { a: ['1'] } }),
    ).toBeNull();
  });
});

describe('publicBrowserService', () => {
  it('exposes only the contract methods', () => {
    const { core } = service();
    expect(Object.keys(publicBrowserService(core)).sort()).toEqual(['fileUrl', 'openExternal', 'ping', 'prepare']);
  });
});

describe('bridge', () => {
  it('only targets direct children of the board with the frame name prefix', () => {
    expect(isBoardFrame({ name: `${BOARD_FRAME_NAME_PREFIX}w1`, parentIsBoard: true })).toBe(true);
    expect(isBoardFrame({ name: `${BOARD_FRAME_NAME_PREFIX}w1`, parentIsBoard: false })).toBe(false);
    expect(isBoardFrame({ name: 'ad', parentIsBoard: true })).toBe(false);
  });

  it('script is valid JavaScript', () => {
    expect(() => new Function(BRIDGE_SCRIPT)).not.toThrow();
  });
});
