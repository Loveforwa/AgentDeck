// 演示页：pnpm --filter @agentdeck/ui-kit demo
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  plugins: [react()],
  server: { port: 5310 },
  build: { outDir: fileURLToPath(new URL('./dist-demo', import.meta.url)), emptyOutDir: true },
});
