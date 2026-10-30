// TC-148（CO4 → MP3）：左边管理面板的 NEEDS YOU 一段列出出错（红）和在等你（黄）的终端，等得最久的在前，带个数；
// 跑着的、空闲的不进这一段（看每行的灯）；shell 也一样按状态。⌥⌘1–9 跳到这一段的第 1–9 行。
// 悬停开着的 agent 一行看最后一条回复（读 tmux 的屏幕），NEEDS YOU 里的写 “Click to jump · ⌥⌘n”。
// 6 个 agent 终端（一个出错退出、一个等批准、两个在跑、一个刚做完一轮、一个一直空闲）和 2 个 shell，都散放（“Not in a workspace”）。
// 出错是真的：假 claude 收到 crash 不发钩子、退出码 3，tmux 报退出、状态机记成 error。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openManager, openTerminal } from '../support/flows.ts';

const REPLY = 'The p99 spike comes from the cold pool in db/pool.ts:88';

async function fakeClaudeAt(deck: Deck, at: { x: number; y: number }) {
  const t = await openTerminal(deck, null, 'claude', undefined, at);
  await deck.waitForPane(t.terminalId, /Fake Claude/);
  await deck.waitForStatus(t.terminalId, 'idle');
  return t;
}

/** 不动焦点，经 tmux 往终端里打一行（像 agent 自己在动）。 */
function send(deck: Deck, terminalId: string, line: string) {
  deck.sb.tmux(['send-keys', '-t', `=${terminalId}:`, '-l', line]);
  deck.sb.tmux(['send-keys', '-t', `=${terminalId}:`, 'Enter']);
}

test('TC-148 NEEDS YOU lists the failed and the waiting terminal (longest wait first), hover shows the last reply, ⌥⌘n follows the rows', async ({ deck }) => {
  await deck.launch();
  const { page } = deck;
  // 第一行：出错、等批准、在跑；第二行：在跑、刚做完、一直空闲；最右一列两个 shell
  const crashed = await fakeClaudeAt(deck, { x: 40, y: 40 });
  const waiting = await fakeClaudeAt(deck, { x: 620, y: 40 });
  const run1 = await fakeClaudeAt(deck, { x: 1200, y: 40 });
  const run2 = await fakeClaudeAt(deck, { x: 40, y: 440 });
  const finished = await fakeClaudeAt(deck, { x: 620, y: 440 });
  const idle = await fakeClaudeAt(deck, { x: 1200, y: 440 });
  const sh1 = await openTerminal(deck, null, 'shell', undefined, { x: 1780, y: 40 });
  const sh2 = await openTerminal(deck, null, 'shell', undefined, { x: 1780, y: 440 });

  send(deck, crashed.terminalId, 'crash');
  await deck.waitForStatus(crashed.terminalId, 'error');
  send(deck, waiting.terminalId, 'ask');
  await deck.waitForStatus(waiting.terminalId, 'needs-approval');
  for (const t of [run1, run2, finished]) {
    send(deck, t.terminalId, 'work');
    await deck.waitForStatus(t.terminalId, 'running');
  }
  send(deck, finished.terminalId, `done ${REPLY}`);
  await deck.waitForStatus(finished.terminalId, 'idle');
  // 出错的终端：窗口还在，底部写退出码
  await expect(deck.windowEl(crashed.windowId).locator('.ad-terminal__bar')).toContainText('3');

  // 点白板空白处（缩小一点留出空白），打开左边管理面板
  await page.evaluate(() => (window as unknown as { __board: { zoomTo(z: number): void } }).__board.zoomTo(0.5));
  await expect.poll(async () => (await deck.board()).viewport.zoom).toBeCloseTo(0.5, 2);
  await expect.poll(() => page.evaluate(() => document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? '')).toContain('scale(0.5)');
  const nav = await openManager(deck);
  const empty = await deck.emptyPoint('bottom');
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();

  // NEEDS YOU：出错的（先出的事）在前，然后等批准的；带个数
  const needs = nav.getByRole('region', { name: 'Needs you' });
  await expect(needs.getByRole('heading')).toHaveText('NEEDS YOU · 2');
  const needRows = needs.locator('.mgr-row');
  await expect(needRows).toHaveCount(2);
  expect(await needRows.evaluateAll((els) => els.map((e) => e.getAttribute('data-window-id')))).toEqual([crashed.windowId, waiting.windowId]);
  // 其余的在 “Not in a workspace” 里，按白板位置，每行的灯写状态；每个终端只出现一次
  const loose = nav.getByRole('region', { name: 'Not in a workspace' });
  expect(await loose.locator('.mgr-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-window-id')))).toEqual(
    [run1, sh1, run2, finished, idle, sh2].map((t) => t.windowId),
  );
  for (const t of [crashed, waiting]) await expect(nav.locator(`.mgr-row[data-window-id="${t.windowId}"]`)).toHaveCount(1);
  const lampOf = (t: { windowId: string }) => nav.locator(`.mgr-row[data-window-id="${t.windowId}"] .mgr-lamp`);
  await expect(lampOf(crashed)).toHaveClass(/mgr-lamp--error/);
  await expect(lampOf(waiting)).toHaveClass(/mgr-lamp--waiting/);
  for (const t of [run1, run2]) await expect(lampOf(t)).toHaveClass(/mgr-lamp--running/);
  for (const t of [finished, idle]) await expect(lampOf(t)).toHaveClass(/mgr-lamp--idle/);
  // 灯和右边的字：出错的是 --status-error、写退出码，等你的写 Waiting（--attention），跑着的、空闲的灰字
  const tokenColor = (token: string) =>
    page.evaluate((token) => {
      const probe = document.createElement('div');
      probe.style.color = `var(${token})`;
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    }, token);
  const errorColor = await tokenColor('--status-error');
  expect(await lampOf(crashed).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(errorColor);
  const timeOf = (t: { windowId: string }) => nav.locator(`.mgr-row[data-window-id="${t.windowId}"] .mgr-time`);
  await expect(timeOf(crashed)).toHaveText(/^exit 3 · (now|\d+m)$/);
  expect(await timeOf(crashed).evaluate((el) => getComputedStyle(el).color)).toBe(errorColor);
  await expect(timeOf(waiting)).toHaveText(/^Waiting · (now|\d+m)$/);
  expect(await timeOf(waiting).evaluate((el) => getComputedStyle(el).color)).toBe(await tokenColor('--attention'));
  await expect(timeOf(run1)).toHaveText(/^Running · (now|\d+m)$/);
  await expect(timeOf(finished)).toHaveText(/^Idle · (now|\d+m)$/);
  expect(await timeOf(run1).evaluate((el) => getComputedStyle(el).color)).toBe(await tokenColor('--muted'));
  await deck.screenshot('needs-you');

  // 悬停刚做完一轮的 claude：黑色提示，最后一条回复和 “Click to jump”（不在 NEEDS YOU，没有快捷键）
  await nav.locator(`.mgr-row[data-window-id="${finished.windowId}"] .mgr-row-main`).hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/claude · Idle · (now|\d+m)/);
  await expect(tip).toContainText('Last reply');
  await expect(tip).toContainText(REPLY);
  await expect(tip).toContainText(/Click to jump$/);
  await deck.screenshot('hover');
  // 悬停 NEEDS YOU 第 2 行：“Click to jump · ⌥⌘2”
  await needRows.nth(1).locator('.mgr-row-main').hover();
  await expect(tip).toContainText('Click to jump · ⌥⌘2');
  await page.mouse.move(empty.x, empty.y);
  await expect(tip).toHaveCount(0);

  // ⌥⌘1：第 1 行（出错的）；⌥⌘2：第 2 行（等批准的）；⌥⌘3：没有这一行，不动
  await page.keyboard.press('Meta+Alt+Digit1');
  await expect.poll(async () => (await deck.board()).focusedId).toBe(crashed.windowId);
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();
  await page.keyboard.press('Meta+Alt+Digit2');
  await expect.poll(async () => (await deck.board()).focusedId).toBe(waiting.windowId);
  await page.keyboard.press('Meta+Alt+Digit3');
  await page.waitForTimeout(300);
  expect((await deck.board()).focusedId).toBe(waiting.windowId);
  await deck.screenshot('after');
});
