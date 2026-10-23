import { describe, expect, it } from 'vitest';
import {
  FileRoots,
  isInside,
  isLocalFileUrl,
  pathFromFileUrl,
  toLocalFileUrl,
} from '../../src/main/browser/local-files.ts';
import { FrameOriginAllowList, isLocalHttpUrl } from '../../src/main/browser/origins.ts';

describe('agentdeck-file:// urls', () => {
  it('maps absolute paths and back, encoding special characters', () => {
    const url = toLocalFileUrl('/Users/me/my report#1?.html');
    expect(url).toBe('agentdeck-file:///Users/me/my%20report%231%3F.html');
    expect(isLocalFileUrl(url)).toBe(true);
    expect(pathFromFileUrl(url)).toBe('/Users/me/my report#1?.html');
  });

  it('rejects relative paths', () => {
    expect(() => toLocalFileUrl('report.html')).toThrow();
  });

  it('accepts file:// urls too', () => {
    expect(pathFromFileUrl('file:///tmp/a.html')).toBe('/tmp/a.html');
  });

  it('resolves dot segments, including encoded ones', () => {
    expect(pathFromFileUrl('agentdeck-file:///a/b/../c.html')).toBe('/a/c.html');
    expect(pathFromFileUrl('agentdeck-file:///a/b/%2e%2e/c.html')).toBe('/a/c.html');
  });

  it('ignores query and hash', () => {
    expect(pathFromFileUrl('agentdeck-file:///a/index.html?x=1#top')).toBe('/a/index.html');
  });

  it('rejects hosts, encoded slashes and other schemes', () => {
    expect(pathFromFileUrl('agentdeck-file://evil/etc/passwd')).toBeNull();
    expect(pathFromFileUrl('agentdeck-file:///a/..%2f..%2fetc/passwd')).toBeNull();
    expect(pathFromFileUrl('http://localhost/a')).toBeNull();
  });
});

describe('FileRoots', () => {
  it('allows the opened file’s directory and its subdirectories only', () => {
    const roots = new FileRoots();
    roots.addFileDir('/Users/me/site/index.html');
    expect(roots.allows('/Users/me/site/index.html')).toBe(true);
    expect(roots.allows('/Users/me/site/css/a.css')).toBe(true);
    expect(roots.allows('/Users/me/secret.txt')).toBe(false);
    expect(roots.allows('/Users/me/site-other/a.html')).toBe(false);
    expect(roots.allows('/etc/passwd')).toBe(false);
  });

  it('isInside handles names that start with dots', () => {
    expect(isInside('/a', '/a/..b/c')).toBe(true);
    expect(isInside('/a', '/a/../b')).toBe(false);
    expect(isInside('/a', '/a')).toBe(true);
  });
});

describe('local origins', () => {
  it('recognises local http(s) hosts', () => {
    for (const url of [
      'http://localhost:3000/',
      'https://localhost/',
      'http://127.0.0.1:8080/x',
      'http://[::1]:5173/',
      'http://0.0.0.0:8000/',
      'http://app.localhost:3000/',
    ]) {
      expect(isLocalHttpUrl(new URL(url)), url).toBe(true);
    }
    for (const url of ['https://example.com/', 'http://localhost.example.com/', 'ftp://localhost/', 'file:///tmp/a']) {
      expect(isLocalHttpUrl(new URL(url)), url).toBe(false);
    }
  });

  it('allow list matches by origin', () => {
    const list = new FrameOriginAllowList();
    expect(list.add(new URL('http://localhost:3000/login'))).toBe(true);
    expect(list.add(new URL('https://example.com/'))).toBe(false);
    expect(list.allows('http://localhost:3000/other?x')).toBe(true);
    expect(list.allows('http://localhost:3001/')).toBe(false);
    expect(list.allows('http://127.0.0.1:3000/')).toBe(false);
    expect(list.allows('https://example.com/')).toBe(false);
    expect(list.allows('not a url')).toBe(false);
  });
});
