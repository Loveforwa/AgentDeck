// 端到端测试前把 apps/desktop 构建到 apps/desktop/out/（和 `pnpm --filter @agentdeck/desktop build` 同一个位置）。
// 和普通 build 只差一处：`import.meta.env.DEV` 定义成 true，界面才会挂出 window.__board（测试用它准备场景、读白板状态）。
// electron-vite build 会把 NODE_ENV 强制成 production，所以不能用 NODE_ENV=development，只能用 define。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '../../apps/desktop');
// electron-vite 是 apps/desktop 的依赖，从那里解析，e2e 包不重复声明
const require = createRequire(resolve(desktop, 'package.json'));
const { build } = await import(require.resolve('electron-vite'));

// renderer 的 html 入口按当前目录算相对路径，必须在 apps/desktop 里跑
process.chdir(desktop);
await build({
  root: desktop,
  logLevel: 'warn',
  define: { 'import.meta.env.DEV': 'true' },
});
console.log('[e2e] built apps/desktop/out with import.meta.env.DEV = true');
