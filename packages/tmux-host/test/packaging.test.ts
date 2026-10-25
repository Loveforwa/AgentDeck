// 打包相关的两个回归测试：IS-09（顶层的 require 名字）、IS-10（打包后默认 tmux.conf 的位置）。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TMUX_CONF, resolveDefaultTmuxConf } from '../src/index.ts';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

describe('IS-09: no module-level binding named require', () => {
  it('src/*.ts never declares its own `require` (vite:esm-shim injects one into the bundle)', () => {
    for (const name of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(join(srcDir, name), 'utf8');
      expect(code, name).not.toMatch(/^\s*(?:const|let|var)\s+require\b/m);
    }
  });
});

describe('IS-10: default tmux.conf', () => {
  it('is the package copy when running from source', () => {
    expect(DEFAULT_TMUX_CONF.endsWith('packages/tmux-host/tmux.conf')).toBe(true);
    expect(existsSync(DEFAULT_TMUX_CONF)).toBe(true);
  });

  it('falls back to <resources>/tmux.conf when the bundle moved away from the package', () => {
    const exists = (p: string) => p === '/App/Contents/Resources/tmux.conf';
    expect(resolveDefaultTmuxConf({ packaged: '/App/Contents/Resources/app.asar/out/tmux.conf', resourcesPath: '/App/Contents/Resources', exists })).toBe(
      '/App/Contents/Resources/tmux.conf',
    );
  });

  it('prefers the package copy, and keeps it when nothing exists', () => {
    expect(resolveDefaultTmuxConf({ packaged: '/pkg/tmux.conf', resourcesPath: '/res', exists: () => true })).toBe('/pkg/tmux.conf');
    expect(resolveDefaultTmuxConf({ packaged: '/pkg/tmux.conf', resourcesPath: '/res', exists: () => false })).toBe('/pkg/tmux.conf');
    expect(resolveDefaultTmuxConf({ packaged: '/pkg/tmux.conf', resourcesPath: undefined, exists: () => false })).toBe('/pkg/tmux.conf');
  });
});
