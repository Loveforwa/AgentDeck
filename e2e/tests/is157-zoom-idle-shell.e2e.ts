// IS-157 待核对：空闲的 shell 在白板缩放以后显示 Running（g1 在 TC-31 的一张截图里见过一次）。
// 复现不出来：空闲的 shell 在各种缩放（⌃滚轮捏合、⌘- ⌘= ⌘0 ⌘1、zoomTo，跨过 50% 变摘要卡又变回来、断开再接回显示）之后
// 一直是 Idle，状态机一次都没变，tmux 里的大小也没变。
// TC-31 的截图是刚开的 shell：shell 打出提示符算一次输出（状态机 starting → running），3 秒没输出才回 Idle。
// 第二条测试量一下这段时间（只记录，不断言：这是现在的规则，见 tmux-host 的 activity.ts）。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal } from '../support/flows.ts';
import { recordStatuses, statusHistory } from '../support/g1.ts';
import { paneVar } from '../support/h2.ts';

/** 等视口停下（连续两次读到一样的）。 */
async function settled(deck: Deck) {
  let last = '';
  await expect
    .poll(
      async () => {
        const v = JSON.stringify((await deck.board()).viewport);
        const same = v === last;
        last = v;
        return same;
      },
      { intervals: [250] },
    )
    .toBe(true);
}

test('IS-157 an idle shell stays Idle while the board zooms (pinch, ⌘- ⌘= ⌘0 ⌘1, below 50% and back)', async ({ deck }) => {
  const page = await deck.launch();
  const sh = await openTerminal(deck, null, 'shell', undefined, { x: 40, y: 40 });
  await deck.waitForPane(sh.terminalId, /e2e\$/);
  await deck.waitForStatus(sh.terminalId, 'idle');
  await page.keyboard.press('Meta+0');
  await settled(deck);
  const size = paneVar(deck, sh.terminalId, '#{pane_width}x#{pane_height}');
  await recordStatuses(page);
  const status = deck.windowEl(sh.windowId).locator('.ad-window-titlebar .ad-window-status');
  const clients = () => deck.sb.tmux(['list-clients', '-t', `=${sh.terminalId}`, '-F', '#{client_tty}']).stdout.trim().split('\n').filter(Boolean).length;
  /** 每一步之后：标题栏还是 Idle，状态机没发过变化，tmux 里的大小没变；再等过 IS-72 的 1 秒窗口和 3 秒的静默再看一次。 */
  const stillIdle = async (step: string) => {
    await settled(deck);
    for (const wait of [0, 1500]) {
      await page.waitForTimeout(wait);
      await expect(status, step).toHaveText(/^Idle/);
      expect(await statusHistory(page, sh.terminalId), step).toEqual([]);
      expect(await deck.status(sh.terminalId), step).toBe('idle');
      expect(paneVar(deck, sh.terminalId, '#{pane_width}x#{pane_height}'), step).toBe(size);
    }
  };

  // 1. 在空白处捏合（带 ctrl 的滚轮）缩小到 50% 以下：终端变摘要卡、断开显示
  const empty = await deck.emptyPoint('right');
  await page.mouse.move(empty.x, empty.y);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 40);
    await page.keyboard.up('Control');
  }
  await settled(deck);
  expect((await deck.board()).viewport.zoom).toBeLessThan(0.5);
  await expect.poll(clients).toBe(0);
  await deck.screenshot('zoomed-out');
  await stillIdle('pinch out');
  // 2. 捏合放大回来（超过 100%）：重新接上显示
  for (let i = 0; i < 8; i++) {
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -40);
    await page.keyboard.up('Control');
  }
  await settled(deck);
  expect((await deck.board()).viewport.zoom).toBeGreaterThan(1);
  await stillIdle('pinch in');
  // 3. 键盘：⌘- ⌘- ⌘= ⌘0 ⌘1
  for (const key of ['Meta+Minus', 'Meta+Minus', 'Meta+Equal', 'Meta+0', 'Meta+1']) {
    await page.keyboard.press(key);
    await stillIdle(key);
  }
  // 4. zoomTo 30%（摘要卡）再 150%（窗口可能一部分出了视口）再 100%
  for (const z of [0.3, 1.5, 1]) {
    await page.evaluate((z) => (window as unknown as { __board: { zoomTo(z: number): void } }).__board.zoomTo(z), z);
    await expect.poll(async () => (await deck.board()).viewport.zoom).toBeCloseTo(z, 2);
    await stillIdle(`zoomTo ${z}`);
  }
  await expect.poll(clients).toBe(1);
  await expect(deck.windowEl(sh.windowId).locator('.ad-terminal__notice')).toHaveCount(0);
  await deck.screenshot('back-to-100');
});

test('IS-157 (origin) a freshly opened shell shows Running until 3 s after its prompt, also when opened at 60% zoom', async ({ deck }) => {
  const page = await deck.launch();
  await page.evaluate(() => {
    const w = window as unknown as { agentdeck: { on(t: string, l: (e: { snapshot: { terminalId: string; status: string } }) => void): void }; __h2Tl: { id: string; status: string; at: number }[] };
    w.__h2Tl = [];
    w.agentdeck.on('status.changed', (e) => w.__h2Tl.push({ id: e.snapshot.terminalId, status: e.snapshot.status, at: Date.now() }));
  });
  await page.evaluate(() => (window as unknown as { __board: { zoomTo(z: number): void } }).__board.zoomTo(0.6));
  await expect.poll(async () => (await deck.board()).viewport.zoom).toBeCloseTo(0.6, 2);
  const sh = await openTerminal(deck, null, 'shell', undefined, { x: 40, y: 40 });
  await deck.waitForPane(sh.terminalId, /e2e\$/);
  await deck.waitForStatus(sh.terminalId, 'idle');
  const tl = (await page.evaluate(() => (window as unknown as { __h2Tl: { id: string; status: string; at: number }[] }).__h2Tl)).filter((e) => e.id === sh.terminalId);
  expect(tl.map((e) => e.status)).toEqual(['starting', 'running', 'idle']);
  const runningMs = tl[2]!.at - tl[1]!.at;
  test.info().annotations.push({ type: 'fresh-shell-running-ms', description: String(runningMs) });
  console.log(`[IS-157] a fresh shell showed Running for ${runningMs} ms after its prompt`);
  // 之后缩放回 100%：不再变 Running
  await page.keyboard.press('Meta+0');
  await page.waitForTimeout(1500);
  expect(await deck.status(sh.terminalId)).toBe('idle');
  await expect(deck.windowEl(sh.windowId).locator('.ad-window-status')).toHaveText(/^Idle/);
});
