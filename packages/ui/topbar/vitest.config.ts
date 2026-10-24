import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    // 测试里用 ?raw 读 topbar.css 检查拖动区（IS-63）；不列进来时 Vitest 把 CSS 换成空串
    css: { include: [/topbar\.css/] },
  },
});
