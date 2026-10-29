// TC-148（CO4）补 tc148-agents-view 没造出来的 ERROR 一组：6 个 agent 终端（一个出错退出、一个等批准、两个在跑、一个刚做完一轮、一个一直空闲）
// 和 2 个 shell，都散放。Agents 视图分组顺序 ERROR、NEEDS YOU、RUNNING、IDLE，每组写个数，只列 agent；组里按白板位置（一行一行从左到右）；
// ⌥⌘1 跳到第 1 行（出错的那个），⌥⌘3 跳到第 3 行。出错是真的：假 claude 收到 crash 不发钩子、退出码 3，tmux 报退出、状态机记成 error。
// 散放而不放进两个项目的框：组里的先后只按位置算，散放的位置是测试定的，顺序才确定（项目 → 框 → 窗口那一层 tc16-tc33-board-nav 核对过）。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal } from '../support/flows.ts';

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

test('TC-148 Agents view with an ERROR group: ERROR, NEEDS YOU, RUNNING, IDLE with counts, shells left out, ⌥⌘n follows the rows', async ({ deck }) => {
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
  send(deck, finished.terminalId, 'done the migration is ready');
  await deck.waitForStatus(finished.terminalId, 'idle');
  // 出错的终端：窗口还在，底部写退出码
  await expect(deck.windowEl(crashed.windowId).locator('.ad-terminal__bar')).toContainText('3');

  // 点白板空白处（缩小一点留出空白）→ BoardNav → Agents
  await page.evaluate(() => (window as unknown as { __board: { zoomTo(z: number): void } }).__board.zoomTo(0.5));
  await expect.poll(async () => (await deck.board()).viewport.zoom).toBeCloseTo(0.5, 2);
  await expect.poll(() => page.evaluate(() => document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? '')).toContain('scale(0.5)');
  const empty = await deck.emptyPoint('bottom');
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();
  const nav = page.getByRole('navigation', { name: 'Board' });
  await nav.getByRole('button', { name: 'Agents', exact: true }).click();

  // 只列 6 个 agent，分组顺序固定、每组写个数
  await expect(nav.getByRole('heading', { name: 'AGENTS · 6' })).toBeVisible();
  await expect(nav.getByRole('heading', { level: 3 })).toHaveText(['ERROR · 1', 'NEEDS YOU · 1', 'RUNNING · 2', 'IDLE · 2']);
  const rows = nav.locator('.bnav-agent-row');
  await expect(rows).toHaveCount(6);
  const order = [crashed, waiting, run1, run2, finished, idle].map((t) => t.windowId);
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-window-id')))).toEqual(order);
  for (const s of [sh1, sh2]) await expect(nav.locator(`[data-window-id="${s.windowId}"]`)).toHaveCount(0);
  // 每组里的行、灯（颜色只在灯上）
  const region = (name: string) => nav.getByRole('region', { name });
  await expect(region('ERROR').locator('.bnav-agent-row')).toHaveCount(1);
  await expect(region('ERROR').locator('.bnav-lamp')).toHaveClass(/bnav-lamp--error/);
  await expect(region('NEEDS YOU').locator('.bnav-lamp')).toHaveClass(/bnav-lamp--waiting/);
  await expect(region('RUNNING').locator('.bnav-lamp--running')).toHaveCount(2);
  await expect(region('IDLE').locator('.bnav-lamp--idle')).toHaveCount(2);
  // 灯的颜色就是 --status-error
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
  const lamp = region('ERROR').locator('.bnav-lamp');
  const lampColors = await lamp.evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.backgroundColor, s.borderTopColor, s.color];
  });
  expect(lampColors).toContain(errorColor);
  // 行右边：出错的写退出码（--status-error），等你的写 Waiting（--attention），跑着的、空闲的只写时间（灰）
  const statusText = (name: string) => region(name).locator('.bnav-agent-status');
  await expect(statusText('ERROR')).toHaveText(/^exit 3 · (now|\d+m)$/);
  expect(await statusText('ERROR').evaluate((el) => getComputedStyle(el).color)).toBe(errorColor);
  await expect(statusText('NEEDS YOU')).toHaveText(/^Waiting · (now|\d+m)$/);
  await expect(statusText('RUNNING')).toHaveText([/^(now|\d+m)$/, /^(now|\d+m)$/]);
  await expect(statusText('IDLE')).toHaveText([/^(now|\d+m)$/, /^(now|\d+m)$/]);
  expect(await statusText('NEEDS YOU').evaluate((el) => getComputedStyle(el).color)).toBe(await tokenColor('--attention'));
  const muted = await tokenColor('--muted');
  for (const name of ['RUNNING', 'IDLE']) {
    expect(await statusText(name).evaluateAll((els) => els.map((e) => getComputedStyle(e).color))).toEqual([muted, muted]);
  }
  await deck.screenshot('agents-with-error');

  // ⌥⌘1：第 1 行（出错的）；⌥⌘3：第 3 行（RUNNING 里的第一个）
  await page.keyboard.press('Meta+Alt+Digit1');
  await expect.poll(async () => (await deck.board()).focusedId).toBe(crashed.windowId);
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();
  await page.keyboard.press('Meta+Alt+Digit3');
  await expect.poll(async () => (await deck.board()).focusedId).toBe(run1.windowId);

  // 回到 Agents 视图：记住了，分组不变
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(async () => (await deck.board()).focusedId).toBeNull();
  await expect(nav.getByRole('heading', { level: 3 })).toHaveText(['ERROR · 1', 'NEEDS YOU · 1', 'RUNNING · 2', 'IDLE · 2']);
  await deck.screenshot('after');
});
