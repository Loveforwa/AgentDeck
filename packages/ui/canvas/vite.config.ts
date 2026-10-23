// dev 页面：pnpm --filter @agentdeck/ui-canvas dev → http://localhost:5320
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./dev', import.meta.url)),
  plugins: [react()],
  server: { port: 5320 },
  build: { outDir: fileURLToPath(new URL('./dist-dev', import.meta.url)), emptyOutDir: true },
});
