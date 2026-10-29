import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// 内部包（@agentdeck/*）都是 TS 源码包，必须打进产物，不能当外部依赖。
// 原生模块 better-sqlite3（store）、node-pty（tmux-host）反过来必须外部化：它们按 process.platform/arch 动态加载 .node，
// 所以也列在本包的 dependencies 里（pnpm 只把直接依赖链到 apps/desktop/node_modules，out/ 里的 require 才找得到）。
const internal = [
  '@agentdeck/agent-adapters',
  '@agentdeck/contracts',
  '@agentdeck/doc-service',
  '@agentdeck/git-service',
  '@agentdeck/mcp-server',
  '@agentdeck/port-watch',
  '@agentdeck/store',
  '@agentdeck/tmux-host',
  '@agentdeck/workspace-service',
];
const bundleInternal = { exclude: internal };
// 以前这里有个插件把 tmux-host/src/pty.ts 自己的 `const require` 改名（和 vite:esm-shim 注入的重名，IS-09）；
// 现在 pty.ts 用 nodeRequire，不需要了。

export default defineConfig({
  main: {
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
