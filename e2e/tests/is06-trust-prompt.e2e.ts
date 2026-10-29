// IS-06：claude 第一次在某个目录启动时停在“信任这个文件夹吗”，这时还没有任何钩子。以前显示 Idle，像是 claude 空着；
// 现在认出屏幕上的提示，显示等你（Needs reply · Trust this folder?），顶栏算一个 waiting；点了信任、SessionStart 到了回到 Idle。
// 假 claude 在当前目录有 .fake-claude-untrusted 时先画真 claude 的提示原文（e2e/fake-agent/fake-claude.mjs）。
import { expect, test } from '../support/fixtures.ts';
import { openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';

const pendingOf = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate(
    (id) =>
      (window as unknown as { __board: { state: { statuses: Record<string, { pending: { summary: string } | null }> } } }).__board.state.statuses[id]
        ?.pending?.summary ?? null,
    id,
  );

test('IS-06 claude on its trust prompt shows Needs you, not Idle; trusting the folder brings it back to Idle', async ({ deck }) => {
  const page = await deck.launch();
  const repo = makeRepo(deck.sb, 'untrusted', { branches: { 'mark-untrusted': { '.fake-claude-untrusted': '' } } });
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/trust');
  const t = await openTerminal(deck, workspaceId, 'claude');
  await deck.showAll();
  await deck.waitForPane(t.terminalId, /Yes, I trust this folder/);

  // 1. 停在提示上：等你，摘要是 Trust this folder?，顶栏 1 waiting
  await deck.waitForStatus(t.terminalId, 'needs-reply');
  expect(await pendingOf(page, t.terminalId)).toBe('Trust this folder?');
  await expect(page.getByText(/1 waiting/).first()).toBeVisible();
  await deck.screenshot('trust-prompt');
  // 一直不点也不会被当成“钩子没来”（10 秒）而降级
  await page.waitForTimeout(11_000);
  expect(await deck.status(t.terminalId)).toBe('needs-reply');

  // 2. 按回车信任：SessionStart 到了，回到 Idle，不再等你
  await deck.focusWindow(t.windowId);
  await page.keyboard.press('Enter');
  await deck.waitForPane(t.terminalId, /Fake Claude/);
  await deck.waitForStatus(t.terminalId, 'idle');
  expect(await pendingOf(page, t.terminalId)).toBeNull();
  await deck.screenshot('trusted');
});
