import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

// 内部包（@agentdeck/*）都是 TS 源码包，必须打进产物，不能当外部依赖。
// 原生模块 better-sqlite3（store）、node-pty（tmux-host）反过来必须外部化：它们按 process.platform/arch 动态加载 .node，
// 所以也列在本包的 dependencies 里（pnpm 只把直接依赖链到 apps/desktop/node_modules，out/ 里的 require 才找得到）。
const internal = [
  '@agentdeck/agent-adapters',
  '@agentdeck/contracts',
  '@agentdeck/git-service',
  '@agentdeck/mcp-server',
  '@agentdeck/port-watch',
  '@agentdeck/store',
  '@agentdeck/tmux-host',
  '@agentdeck/workspace-service',
];
const bundleInternal = { exclude: internal };

/**
 * electron-vite 给用到 require( 的 ESM 产物加一段 `const require = createRequire(import.meta.url)`（vite:esm-shim），
 * 而 packages/tmux-host/src/pty.ts 自己也在顶层声明了 `const require`，打进同一个 chunk 后变成重复声明（SyntaxError）。
 * 这里在打包前把这种模块自己的 require 改个名字。见问题清单 IS-09（docs/status/tracking.py）。
 */
function renameLocalRequire(): Plugin {
  return {
    name: 'agentdeck:rename-local-require',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/packages/') || !/\bconst require = createRequire\(/.test(code)) return null;
      return { code: code.replace(/\brequire\b/g, '__agentdeckLocalRequire'), map: null };
    },
  };
}

export default defineConfig({
  main: {
    plugins: [renameLocalRequire()],
    build: { externalizeDeps: bundleInternal },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ['@agentdeck/contracts'] },
      // sandbox 下 preload 只能是 CommonJS。
      rolldownOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
