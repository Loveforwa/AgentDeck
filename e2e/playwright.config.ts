// 端到端测试（R2）：Playwright 的 Electron 模式驱动真的 AgentDeck。跑法见 e2e/AGENTS.md。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // 用 .e2e.ts 结尾：根目录的 vitest 只收 *.test.* / *.spec.*，不会把这些当单元测试跑
  testMatch: '**/*.e2e.ts',
  outputDir: './test-results',
  // 每个测试起一个 Electron 加一个 tmux 服务；串行跑最稳（窗口焦点、键盘输入不会互相抢）
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]] : [['list']],
  use: {
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
  },
});
