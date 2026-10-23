import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// contracts 是 TS 源码包，必须打进产物，不能当外部依赖。
const bundleContracts = { exclude: ['@agentdeck/contracts'] };

export default defineConfig({
  main: {
    build: { externalizeDeps: bundleContracts },
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
