// Playwright 夹具：每个测试一个沙盒（sb）和一个 AgentDeck（deck，还没启动，测试里调 deck.launch()）。
// 结束时先关应用、再 kill tmux 服务、删临时目录。
import { test as base } from '@playwright/test';
import { Deck } from './deck.ts';
import { createSandbox, type Sandbox } from './sandbox.ts';

export const test = base.extend<{ sb: Sandbox; deck: Deck }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright 要求第一个参数是解构
  sb: async ({}, use, info) => {
    const sb = createSandbox(info.title);
    await use(sb);
    if (process.env['AGENTDECK_E2E_KEEP'] === '1') console.log(`[e2e] kept sandbox ${sb.root} (tmux -L ${sb.tmuxSocket})`);
    else sb.dispose();
  },
  deck: async ({ sb }, use, info) => {
    const deck = new Deck(sb, info);
    await use(deck);
    await deck.finish();
  },
});

export { expect } from '@playwright/test';
