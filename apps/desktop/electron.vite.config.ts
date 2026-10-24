import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// contracts 是 TS 源码包，必须打进产物，不能当外部依赖。
const bundleContracts = { exclude: ['@agentdeck/contracts'] };
// 主进程用的服务包也是 TS 源码，一样打进去（它们的第三方依赖跟着打进去）。
const bundleServices = { exclude: ['@agentdeck/contracts', '@agentdeck/mcp-server'] };

export default defineConfig({
  main: {
    build: { externalizeDeps: bundleServices },
  },
  preload: {
    build: {
      externalizeDeps: bundleContracts,
      // sandbox 下 preload 只能是 CommonJS。
      rolldownOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
