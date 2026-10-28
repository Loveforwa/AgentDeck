// TC-34（N1）：白板上的 claude 自己用 MCP 开 3 个子终端（open_terminals）和一个网页（open_browser）；关掉它以后子终端变回普通窗口。
// TC-35（N2）：子终端组的侧边栏：状态灯、在等你的行浅黄底、单击一行换右边显示的子终端、Show all、Collapse group、⌘J 调出收起的在等你的那个。
// 调用者是框里的假 claude（测试用它的终端钥匙发 MCP 请求，和 claude 调工具发的一样）；子终端也是假 claude，第一条消息就是它要做的事
// （work = 一直在干活，ask rm -rf build = 停下来等批准）。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, setupWorktree } from '../support/flows.ts';
import { mcpCall } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

type Opened = { workspaceId: string | null; lead: string; terminals: { terminalId: string; label: string | null }[] };

/** 开好一组：lead 是框里的 claude，3 个子 claude（api 在干活、ui 空闲、tests 等批准）。 */
async function openGroup(deck: Deck, workspaceId: string, lead: { terminalId: string }) {
  const r = await mcpCall(deck.sb, lead.terminalId, 'open_terminals', {
    count: 3,
    agent: 'claude',
    labels: ['api', 'ui', 'tests'],
    prompts: ['work', 'done', 'ask rm -rf build'],
  });
  expect(r.isError, r.text).toBe(false);
  const o = r.json as Opened;
  expect(o.workspaceId).toBe(workspaceId);
  expect(o.terminals.map((t) => t.label)).toEqual(['api', 'ui', 'tests']);
  const [api, ui, tests] = o.terminals.map((t) => t.terminalId) as [string, string, string];
  const win = async (tid: string) => (await deck.board()).windows.find((w) => w.data['terminalId'] === tid)?.id ?? null;
  await expect.poll(async () => [await win(api), await win(ui), await win(tests)].every(Boolean), { timeout: 30_000 }).toBe(true);
  await deck.waitForStatus(api, 'running');
  await deck.waitForStatus(ui, 'idle');
  await deck.waitForStatus(tests, 'needs-approval');
  return { api: { terminalId: api, windowId: (await win(api))! }, ui: { terminalId: ui, windowId: (await win(ui))! }, tests: { terminalId: tests, windowId: (await win(tests))! } };
}

test('TC-34 an agent on the board opens 3 subagent terminals and a web page next to itself; closing it turns them into plain windows', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/split');
  const lead = await openFakeClaude(deck, workspaceId);
  // 前提：AgentDeck 重启过（⌘Q 再打开；claude 留在 tmux 里接回来，MCP 照样认它）
  await deck.quit();
  const page = await deck.launch();
  await expect.poll(async () => (await deck.board()).windows.find((w) => w.id === lead.windowId)?.data['terminalId']).toBe(lead.terminalId);
  await deck.waitForPane(lead.terminalId, /Fake Claude/);

  // 1. “开 3 个 subagent 分别看 api、ui、tests”
  const subs = await openGroup(deck, workspaceId, lead);
  const sidebar = page.locator('.ad-group-sidebar');
  await expect(sidebar).toHaveCount(1);
  await expect(sidebar.locator('.ad-group-sidebar-head')).toHaveText('3 subagents');
  await expect(sidebar.locator('.ad-group-row-name')).toHaveText(['sub-1 · api', 'sub-2 · ui', 'sub-3 · tests']);
  // 侧边栏贴在 lead 右边；三个子终端在同一个框里
  const leadBox = (await deck.windowEl(lead.windowId).boundingBox())!;
  const sideBox = (await sidebar.boundingBox())!;
  expect(sideBox.x).toBeGreaterThan(leadBox.x + leadBox.width - 2);
  expect(sideBox.x - (leadBox.x + leadBox.width)).toBeLessThan(40);
  expect(Math.abs(sideBox.y - leadBox.y)).toBeLessThan(4);
  let b = await deck.board();
  for (const s of Object.values(subs)) {
    const w = b.windows.find((x) => x.id === s.windowId)!;
    expect(w.workspaceId).toBe(workspaceId);
    expect((w as unknown as { group?: { role: string } }).group?.role).toBe('member');
  }
  await deck.screenshot('group');

  // 2. “打开 localhost:3000”：网页窗口开在同一个框里、lead 旁边
  const br = await mcpCall(sb, lead.terminalId, 'open_browser', { url: 'localhost:3000' });
  expect(br.isError, br.text).toBe(false);
  const browserId = await deck.waitForWindow((w) => w.type === 'browser');
  b = await deck.board();
  const browser = b.windows.find((w) => w.id === browserId)!;
  expect(browser.workspaceId).toBe(workspaceId);
  expect(browser.data['url']).toBe('http://localhost:3000/');
  const leadRect = b.windows.find((w) => w.id === lead.windowId)!.rect;
  // 不压住 lead
  const overlap = (a: typeof leadRect, c: typeof leadRect) => a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
  expect(overlap(browser.rect, leadRect)).toBe(false);
  // 组信息随白板保存（白板改动后半秒存）
  await expect
    .poll(async () => {
      const saved = await page.evaluate(() =>
        (window as unknown as { agentdeck: { board: { load(): Promise<{ windows: { id: string; group?: { role: string; id: string } }[] }> } } }).agentdeck.board.load(),
      );
      return saved.windows.filter((w) => w.group).map((w) => w.group!.role).sort();
    })
    .toEqual(['lead', 'member', 'member', 'member']);
  await deck.showAll();
  await deck.screenshot('browser');

  // 3. 关掉主 claude：标题栏的关闭 → 确认 “Stop claude …?” → Stop and close
  // 关闭按钮在悬停时才显示：先悬停标题栏，再像真人一样按下、抬起
  const titlebar = deck.windowEl(lead.windowId).locator('.ad-window-titlebar');
  await titlebar.hover({ position: { x: 80, y: 12 } });
  const close = titlebar.getByRole('button', { name: 'Close' });
  await expect(close).toBeVisible();
  await close.click({ delay: 80 });
  const confirm = deck.windowEl(lead.windowId).getByRole('alertdialog');
  await expect(confirm).toContainText(/^Stop claude/);
  await deck.screenshot('stop-confirm');
  await confirm.getByRole('button', { name: 'Stop and close' }).click();
  await expect(deck.windowEl(lead.windowId)).toHaveCount(0);
  // 子终端变成普通窗口：没有组、侧边栏没了、三个都显示着，进程还在
  await expect(sidebar).toHaveCount(0);
  b = await deck.board();
  for (const s of Object.values(subs)) {
    const w = b.windows.find((x) => x.id === s.windowId);
    expect(w, s.terminalId).toBeTruthy();
    expect((w as unknown as { group?: unknown }).group ?? null).toBeNull();
    await expect(deck.windowEl(s.windowId)).toBeVisible();
  }
  expect(await deck.status(subs.api.terminalId)).toBe('running');
  expect(sb.tmux(['has-session', '-t', `=${lead.terminalId}`]).status).not.toBe(0);
  await deck.screenshot('ungrouped');
});

test('TC-35 group sidebar: lamps, waiting row highlighted, click a row, Show all, Collapse group, ⌘J brings back the waiting one', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/sidebar');
  const lead = await openFakeClaude(deck, workspaceId);
  const subs = await openGroup(deck, workspaceId, lead);
  const sidebar = page.locator('.ad-group-sidebar');
  const row = (windowId: string) => sidebar.locator(`.ad-group-row[data-window-id="${windowId}"]`);
  const shown = async () => {
    const out: string[] = [];
    for (const [k, s] of Object.entries(subs)) if ((await deck.windowEl(s.windowId).count()) > 0) out.push(k);
    return out;
  };

  // 1. 侧边栏：每行一个状态灯；在等你的 sub-3 · tests 浅黄底（--attention-soft）
  await expect(row(subs.api.windowId).locator('.ad-group-lamp')).toHaveClass(/ad-group-lamp--running/);
  await expect(row(subs.ui.windowId).locator('.ad-group-lamp')).toHaveClass(/ad-group-lamp--idle/);
  await expect(row(subs.tests.windowId).locator('.ad-group-lamp')).toHaveClass(/ad-group-lamp--waiting/);
  await expect(row(subs.tests.windowId)).toHaveClass(/ad-group-row--waiting/);
  await expect(row(subs.api.windowId)).not.toHaveClass(/ad-group-row--waiting/);
  const soft = await page.evaluate(() => {
    const p = document.createElement('span');
    p.style.backgroundColor = 'var(--attention-soft)';
    document.body.appendChild(p);
    const c = getComputedStyle(p).backgroundColor;
    p.remove();
    return c;
  });
  expect(await row(subs.tests.windowId).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(soft);
  await deck.screenshot('sidebar');

  // 2. 单击另一行：右边只显示那个子终端
  await row(subs.ui.windowId).click();
  await expect.poll(shown).toEqual(['ui']);
  await expect(sidebar).toHaveAttribute('data-view', 'one');
  await expect(row(subs.ui.windowId)).toHaveAttribute('aria-pressed', 'true');
  // 进程照常在跑（收起的不结束）
  expect(await deck.status(subs.api.terminalId)).toBe('running');
  await deck.screenshot('one');

  // 3. Show all 平铺；Collapse group 只剩侧边栏，顶栏仍算 1 waiting
  await sidebar.getByRole('button', { name: 'Show all' }).click();
  await expect.poll(shown).toEqual(['api', 'ui', 'tests']);
  await expect(sidebar).toHaveAttribute('data-view', 'all');
  await deck.screenshot('show-all');
  await sidebar.getByRole('button', { name: 'Collapse group' }).click();
  await expect.poll(shown).toEqual([]);
  await expect(sidebar).toHaveAttribute('data-view', 'collapsed');
  await expect(page.locator('.ad-topbar-waiting')).toHaveText(/1 waiting/);
  await deck.screenshot('collapsed');

  // 4. ⌘J：收起的、在等你的子终端调出来并聚焦
  // 焦点在 lead 上（不是被测的步骤，走白板控制器）
  await page.evaluate((id) => (window as unknown as { __board: { focusWindow(id: string): void } }).__board.focusWindow(id), lead.windowId);
  await expect.poll(async () => (await deck.board()).focusedId).toBe(lead.windowId);
  await page.keyboard.press('Meta+J');
  await expect.poll(async () => (await deck.board()).focusedId).toBe(subs.tests.windowId);
  await expect.poll(shown).toEqual(['tests']);
  await expect(deck.windowEl(subs.tests.windowId)).toBeVisible();
  await deck.screenshot('cmd-j');
  // 收起时 tmux 里的进程一直在（等批准的那个还在等）
  expect(await deck.status(subs.tests.terminalId)).toBe('needs-approval');
  expect(sb.tmux(['has-session', '-t', `=${subs.api.terminalId}`]).status).toBe(0);
});
