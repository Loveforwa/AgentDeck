// TC-30 一眼看出谁在干活、谁在等你（红绿灯）；TC-05 ⌘J 跳到在等你的窗口，直接批准，agent 继续干活。
// agent 是假 claude（e2e/fake-agent/fake-claude.mjs）：真的经 --settings 里的钩子调 agentdeck-notify，状态机按钩子走。
import type { Locator, Page } from '@playwright/test';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';

/** design-tokens 里一个颜色变量解析出来的值（和元素的 computed 颜色同一种写法）。 */
async function tokenColor(page: Page, name: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
}

async function lampColor(lamp: Locator): Promise<string> {
  return lamp.evaluate((el) => {
    const s = getComputedStyle(el);
    return s.backgroundColor !== 'rgba(0, 0, 0, 0)' ? s.backgroundColor : s.color;
  });
}

function titlebar(deck: Deck, windowId: string): Locator {
  return deck.windowEl(windowId).locator('.ad-window-titlebar');
}

test('TC-30 status lights: running green, waiting yellow, idle hollow, error red', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'api');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/lights');
  const a = await openFakeClaude(deck, workspaceId);
  const b = await openFakeClaude(deck, workspaceId);
  await deck.showAll();

  // 前提：一个 claude 在跑，另一个停在等批准（真的在终端里打字，经 xterm → tmux 送进假 claude）
  await deck.focusWindow(a.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(a.terminalId, 'running');
  await deck.focusWindow(b.windowId);
  await deck.typeLine('ask rm -rf build');
  await deck.waitForStatus(b.terminalId, 'needs-approval');
  // 焦点放回 a：等你的 b 没聚焦，应该有黄边框
  await deck.focusWindow(a.windowId);

  // 1. 顶栏右边：“● 1 running ● 1 waiting”
  const running = page.locator('.ad-topbar-count--running');
  const waiting = page.locator('.ad-topbar-waiting');
  await expect(running).toHaveText('1 running');
  await expect(waiting).toHaveText(/1 waiting/);
  // 2. 标题栏：a 绿灯 Running，b 黄灯 Waiting（悬停看是批准）；框标题同样两个灯
  await expect(titlebar(deck, a.windowId).locator('.ad-window-status--running')).toHaveText(/^Running/);
  await expect(titlebar(deck, a.windowId).locator('.ad-window-dot--filled.ad-window-dot--running')).toBeVisible();
  const bStatus = titlebar(deck, b.windowId).locator('.ad-window-status--attention');
  await expect(bStatus).toHaveText(/^Waiting/);
  await expect(bStatus).toHaveAttribute('title', 'Needs approval');
  await expect(deck.windowEl(b.windowId).locator('.ad-window')).toHaveClass(/ad-window--attention/);
  const frame = deck.frameEl('feat/lights');
  await expect(frame.locator('.ad-frame-running')).toHaveText('1 running');
  await expect(frame.locator('.ad-frame-waiting')).toHaveText('1 waiting');
  await bStatus.hover();
  await deck.screenshot('running-and-waiting');

  // 后台：状态色来自 design-tokens（灯的颜色就是 --status-running / --status-waiting）
  const green = await tokenColor(page, '--status-running');
  const yellow = await tokenColor(page, '--status-waiting');
  expect(green).not.toBe(yellow);
  expect(await lampColor(running.locator('.ad-topbar-lamp'))).toBe(green);
  expect(await lampColor(waiting.locator('.ad-topbar-lamp'))).toBe(yellow);
  expect(await lampColor(frame.locator('.ad-frame-running .ad-frame-lamp'))).toBe(green);
  expect(await lampColor(frame.locator('.ad-frame-waiting .ad-frame-lamp'))).toBe(yellow);
  // 后台：状态是钩子送来的（假 claude 真的跑了 agentdeck-notify），主进程的状态机和界面一致
  expect(deck.agentLog(b.terminalId).some((e) => e.kind === 'hook' && e.event === 'PermissionRequest' && e.wired)).toBe(true);
  const snap = await page.evaluate(() =>
    (window as unknown as { agentdeck: { status: { snapshot(): Promise<{ terminalId: string; status: string }[]> } } }).agentdeck.status.snapshot(),
  );
  expect(snap.find((s) => s.terminalId === a.terminalId)?.status).toBe('running');
  expect(snap.find((s) => s.terminalId === b.terminalId)?.status).toBe('needs-approval');

  // 空闲是空心灰 Idle：a 一轮结束（Stop 钩子）
  await deck.focusWindow(a.windowId);
  await deck.typeLine('done');
  await deck.waitForStatus(a.terminalId, 'idle');
  await expect(titlebar(deck, a.windowId).locator('.ad-window-status--muted')).toHaveText(/^Idle/);
  await expect(titlebar(deck, a.windowId).locator('.ad-window-dot--hollow')).toBeVisible();
  await expect(running).toHaveCount(0);

  // 出错是红灯 Error：第三个假 claude 以退出码 3 结束
  const c = await openFakeClaude(deck, workspaceId);
  await deck.showAll();
  await deck.focusWindow(c.windowId);
  await deck.typeLine('crash');
  await deck.waitForStatus(c.terminalId, 'error');
  const err = titlebar(deck, c.windowId).locator('.ad-window-status--error');
  await expect(err).toHaveText(/^Error · exit 3/);
  const red = await tokenColor(page, '--status-error');
  expect(await lampColor(titlebar(deck, c.windowId).locator('.ad-window-dot--error'))).toBe(red);
  await deck.screenshot('idle-and-error');
});

test('TC-05 ⌘J jumps to the waiting claude, pressing 1 approves, it runs again', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'api');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/jump');
  const agent = await openFakeClaude(deck, workspaceId);
  // 另一个散放的 Shell（放在框的右边，不压住 claude），焦点停在它上面
  const frameRect = (await deck.board()).frames[0]!.rect;
  const other = await openTerminal(deck, null, 'shell', undefined, { x: frameRect.x + frameRect.w + 120, y: frameRect.y });
  await deck.showAll();

  // 前提（TC-04 的状态）：claude 在 Needs approval
  await deck.focusWindow(agent.windowId);
  await deck.typeLine('ask ls -la');
  await deck.waitForStatus(agent.terminalId, 'needs-approval');
  await deck.focusWindow(other.windowId);

  // 把白板拖开，让在等你的窗口不在视口里（真的拖空白处）
  for (let i = 0; i < 3; i++) {
    const from = await deck.emptyPoint('right');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 700, from.y + 300, { steps: 12 });
    await page.mouse.up();
  }
  const fullyVisible = (id: string) =>
    page.evaluate((id) => {
      const el = document.querySelector(`.ad-window-node[data-window-id="${id}"]`);
      const pane = document.querySelector('.react-flow__pane');
      if (!el || !pane) return false;
      const r = el.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      return r.left >= p.left && r.top >= p.top && r.right <= p.right && r.bottom <= p.bottom;
    }, id);
  expect(await fullyVisible(agent.windowId)).toBe(false);
  // 拖白板会取消聚焦；重新聚焦 Shell，⌘J 从别的窗口出发
  await page.evaluate((id) => (window as unknown as { __board: { focusWindow(id: string): void } }).__board.focusWindow(id), other.windowId);
  await expect(page.locator('.ad-topbar-waiting')).toHaveText('1 waiting');
  await deck.screenshot('before-cmd-j');

  // 1. ⌘J
  await page.keyboard.press('Meta+J');
  // UI：平移到那个窗口并聚焦、闪一下；黄边框消失（聚焦了），状态仍是黄色 Waiting；顶栏 “1/1 waiting”
  await expect.poll(async () => (await deck.board()).focusedId).toBe(agent.windowId);
  await expect.poll(() => fullyVisible(agent.windowId), { message: 'window panned into view' }).toBe(true);
  await expect(deck.windowEl(agent.windowId).locator('.ad-window-flash')).toHaveCount(1);
  await expect(deck.windowEl(agent.windowId).locator('.ad-window')).not.toHaveClass(/ad-window--attention/);
  await expect(titlebar(deck, agent.windowId).locator('.ad-window-status--attention')).toHaveText(/^Waiting/);
  await expect(page.locator('.ad-topbar-waiting')).toHaveText('1/1 waiting');
  await deck.screenshot('after-cmd-j');

  // 2. 在终端里按 claude 的“允许一次”键 1（IS-12：claude 是 1）
  await page.keyboard.press('1');
  // UI：状态变 Running，waiting 消失
  await deck.waitForStatus(agent.terminalId, 'running');
  await expect(titlebar(deck, agent.windowId).locator('.ad-window-status--running')).toHaveText(/^Running/);
  await expect(page.locator('.ad-topbar-waiting')).toHaveCount(0);
  // 框里的 claude 算进 running（散放的 Shell 刚画完提示符时也可能短暂算 running，所以不卡死数字）
  await expect(deck.frameEl('feat/jump').locator('.ad-frame-running')).toHaveText('1 running');
  // 后台：按键经 tmux-host 送进了 claude，它批准后发了 PostToolUse
  await deck.waitForPane(agent.terminalId, /Allowed \(key\)/);
  const log = deck.agentLog(agent.terminalId);
  expect(log.some((e) => e.kind === 'approved' && e.how === 'key')).toBe(true);
  expect(log.some((e) => e.kind === 'hook' && e.event === 'PostToolUse')).toBe(true);
  await deck.screenshot('approved-running');
});
