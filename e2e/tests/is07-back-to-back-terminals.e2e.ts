// IS-07：连着新建几个终端（不等），每个都正常接上，不会有一个误显示 “Previous session ended”。
// 2026-10-25 X6 修的（合并过的 terminals.list() 里找不到新终端时再问一次），以前 e2e 的 openTerminal 隔 600ms 绕开它；
// 2026-10-29 去掉了那个间隔，所有 spec 都是紧接着开。这里专门连开 5 个，再多等一会儿看有没有哪个变成 “ended”。
import { expect, test } from '../support/fixtures.ts';
import { openTerminal } from '../support/flows.ts';

test('IS-07 five terminals opened back to back all attach; none says “Previous session ended”', async ({ deck }) => {
  const page = await deck.launch();
  const opened = await Promise.all(
    [0, 1, 2, 3, 4].map((i) => openTerminal(deck, null, 'shell', undefined, { x: 40 + (i % 3) * 620, y: 40 + Math.floor(i / 3) * 420 })),
  );
  await deck.showAll();
  for (const t of opened) await deck.waitForPane(t.terminalId, /\$ *$/m);
  // “Previous session ended” 是在对 terminals.list() 的结果时出的，给它 2 秒机会
  await page.waitForTimeout(2000);
  for (const t of opened) {
    await expect(deck.windowEl(t.windowId).getByText('Previous session ended')).toHaveCount(0);
    await expect(deck.windowEl(t.windowId).locator('.xterm')).toBeVisible();
  }
  await deck.screenshot('five-terminals');
});
