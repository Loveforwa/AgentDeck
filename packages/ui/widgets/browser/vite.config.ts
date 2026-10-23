// dev 页面：pnpm --filter @agentdeck/ui-widget-browser dev → http://localhost:5330
// 同时起两个本地登录服务（dev/login-app.ts），给网页窗口一个可以打开的“本地 dev server”：
//   http://localhost:5331  带 X-Frame-Options: DENY（普通浏览器里会被拒，只有 Electron 改写响应头后能显示）
//   http://localhost:5332  不带，普通浏览器里也能嵌
import react from '@vitejs/plugin-react';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { createLoginApp } from './dev/login-app.ts';

function loginServers(): Plugin {
  const servers: Server[] = [];
  return {
    name: 'agentdeck-login-servers',
    configureServer(server) {
      const start = (port: number, denyFraming: boolean) => {
        const s = createServer(createLoginApp({ denyFraming, label: `dev server :${port}` }));
        s.on('error', (err) => server.config.logger.warn(`login server :${port}: ${err.message}`));
        s.listen(port, 'localhost', () => server.config.logger.info(`  login server  http://localhost:${port}/`));
        servers.push(s);
      };
      start(5331, true);
      start(5332, false);
      server.httpServer?.on('close', () => servers.forEach((s) => s.close()));
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./dev', import.meta.url)),
  plugins: [react(), loginServers()],
  server: { port: 5330, strictPort: true },
});
