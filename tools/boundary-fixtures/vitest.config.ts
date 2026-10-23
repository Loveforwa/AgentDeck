import { defineConfig } from 'vitest/config';

// cases/ 和 eslint/ 下是故意违规的样例，不是测试，只跑本目录的 *.test.ts
export default defineConfig({
  test: {
    name: 'boundary-fixtures',
    include: ['*.test.ts'],
  },
});
