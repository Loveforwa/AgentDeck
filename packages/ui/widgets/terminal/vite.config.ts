// dev 页面：pnpm --filter @agentdeck/ui-widget-terminal dev → http://localhost:5340
// 默认用假 api（tools/fakes 的 createFakeApi）。想接真 tmux：另开一个终端跑
//   pnpm --filter @agentdeck/tmux-host dev:bridge
// 然后打开 http://localhost:5340/?real=1（/bridge 由这里转给 bridge 的 5341 端口）。
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./dev', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5340,
    strictPort: true,
    proxy: { '/bridge/': { target: 'http://127.0.0.1:5341', changeOrigin: false } },
  },
});
