// TC-17 右键新建终端，菜单只列出能用的 agent；TC-21 右键在白板上开一个 Shell 并使用；TC-22 关闭运行中的终端会结束进程。
// 全程真的右键菜单、键盘、标题栏按钮；后台核对 agents.list()、tmux（会话、窗格环境、当前目录）、状态机。
import { expect, test } from '../support/fixtures.ts';
import { installFake, recordStatuses, statusHistory, xtermOf } from '../support/g1.ts';

test('TC-17 New terminal ▸ lists the installed agents by name, the picked one opens where you right-clicked', async ({ deck, sb }) => {
  // 前提：本机装了 claude 和 codex（沙盒里是假的：fakebin 在 PATH 最前面）
  installFake(sb, 'codex', 'fake-codex-mini.mjs');
  const page = await deck.launch();
  const agents = await page.evaluate(() =>
    (window as unknown as { agentdeck: { agents: { list(): Promise<{ id: string; label: string; installed: boolean }[]> } } }).agentdeck.agents.list(),
  );
  // 后台：agents.list() 报 claude、codex 装了（沙盒里的假命令）
  const claude = agents.find((a) => a.id === 'claude');
  const codex = agents.find((a) => a.id === 'codex');
  expect(claude?.installed).toBe(true);
  expect(codex?.installed).toBe(true);
  const installed = agents.filter((a) => a.installed && a.id !== 'shell' && a.id !== 'custom');
  const missing = agents.filter((a) => !a.installed && a.id !== 'custom');

  // 1. 空白处右键 › New terminal ▸
  const at = await deck.emptyPoint();
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const parent = page.getByRole('menuitem', { name: /^New terminal/ });
  await parent.hover();
  await parent.click();
  const sub = page.getByRole('menu').last();
  const labels = (await sub.getByRole('menuitem').allInnerTexts()).map((t) => t.trim());
  // UI：用适配器的名字（不是 id）列出装了的，最后是 Shell；没装的不出现
  expect(labels).toContain('Claude Code');
  expect(labels).toContain('Codex');
  expect(labels[labels.length - 1]).toBe('Shell');
  expect(labels).toEqual([...installed.map((a) => a.label), 'Shell']);
  for (const a of missing) expect(labels).not.toContain(a.label);
  expect(labels).not.toContain('claude');
  expect(labels).not.toContain('codex');
  await deck.screenshot('new-terminal-menu');

  // 选 Codex：在右键的位置开终端，跑的是（假的）codex
  await sub.getByRole('menuitem', { name: /^Codex$/ }).click();
  const id = await deck.waitForWindow((w) => w.type === 'terminal' && w.data['agent'] === 'codex');
  const flow = await page.evaluate((p) => (window as unknown as { __board: { clientToFlow(p: object): { x: number; y: number } } }).__board.clientToFlow(p), at);
  const rect = (await deck.board()).windows.find((w) => w.id === id)!.rect;
  expect(Math.abs(rect.x - flow.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(rect.y - flow.y)).toBeLessThanOrEqual(1);
  const terminalId = await deck.terminalIdOf(id);
  await deck.waitForPane(terminalId, /Fake Codex/);
  await deck.screenshot('codex-opened');
});

test('TC-21 right-click › New terminal › Shell opens a shell at that spot in ~, git status runs', async ({ deck, sb }) => {
  const page = await deck.launch();
  await recordStatuses(page);

  // 1. 空白处右键 › New terminal ▸ Shell
  const at = await deck.emptyPoint();
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await deck.pickMenu(['New terminal', 'Shell']);
  const id = await deck.waitForWindow((w) => w.type === 'terminal');
  const b = await deck.board();
  const win = b.windows.find((w) => w.id === id)!;
  // UI：终端在点击的位置（窗口左上角 = 右键点的白板坐标），散放（不在框里）
  const flow = await page.evaluate((p) => (window as unknown as { __board: { clientToFlow(p: object): { x: number; y: number } } }).__board.clientToFlow(p), at);
  expect(Math.abs(win.rect.x - flow.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(win.rect.y - flow.y)).toBeLessThanOrEqual(1);
  expect(win.workspaceId).toBeNull();
  expect(win.data['agent']).toBe('shell');
  const terminalId = await deck.terminalIdOf(id);
  await deck.waitForPane(terminalId, /e2e\$/);
  await expect(deck.windowEl(id).locator('.ad-terminal__notice')).toHaveCount(0);

  // 后台：tmux 里新建了会话，窗格带 AGENTDECK_TERM，散放的终端在 ~（沙盒的 HOME）
  expect(sb.tmux(['has-session', '-t', `=${terminalId}`]).status).toBe(0);
  expect(sb.tmux(['show-environment', '-t', `=${terminalId}`, 'AGENTDECK_TERM']).stdout.trim()).toBe(`AGENTDECK_TERM=${terminalId}`);
  const cwd = sb.tmux(['display-message', '-p', '-t', `=${terminalId}:`, '#{pane_current_path}']).stdout.trim();
  expect(cwd).toBe(sb.home);
  await deck.screenshot('shell-opened');

  // 2. 输入 git status（真的键盘：单击聚焦，再打字）
  await deck.focusWindow(id);
  await deck.typeLine('git status');
  // 输出正常显示：tmux 里有，界面的 xterm 里也有（输出经 MessagePort 送到界面）
  await deck.waitForPane(terminalId, /not a git repository/);
  await expect.poll(async () => (await xtermOf(page, id))?.lines.join('\n') ?? '').toMatch(/not a git repository/);
  // 状态 Running 后变 Idle
  await deck.waitForStatus(terminalId, 'idle');
  await expect.poll(() => statusHistory(page, terminalId)).toEqual(expect.arrayContaining(['running', 'idle']));
  const hist = await statusHistory(page, terminalId);
  expect(hist.lastIndexOf('idle')).toBeGreaterThan(hist.indexOf('running'));
  await expect(deck.windowEl(id).locator('.ad-window-status')).toHaveText(/^Idle/);
  await deck.screenshot('git-status');
});

test('TC-22 closing a running terminal asks first, then stops the process', async ({ deck, sb }) => {
  const page = await deck.launch();
  // 前提：一个在跑的终端
  const at = await deck.emptyPoint();
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await deck.pickMenu(['New terminal', 'Shell']);
  const id = await deck.waitForWindow((w) => w.type === 'terminal');
  const terminalId = await deck.terminalIdOf(id);
  await deck.waitForPane(terminalId, /e2e\$/);
  await deck.focusWindow(id);
  await deck.typeLine('sleep 300');
  await expect.poll(() => sb.tmux(['display-message', '-p', '-t', `=${terminalId}:`, '#{pane_current_command}']).stdout.trim()).toBe('sleep');

  // 1. 单击标题栏的关闭
  await deck.windowEl(id).getByRole('button', { name: 'Close' }).click();
  // UI：先弹确认（画在这个窗口里），窗口还在、进程还在
  const confirm = deck.windowEl(id).getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(/Stop bash/);
  await expect(confirm.getByRole('button', { name: 'Stop and close' })).toBeVisible();
  expect(sb.tmux(['has-session', '-t', `=${terminalId}`]).status).toBe(0);
  await deck.screenshot('confirm');

  // 2. 选结束并关闭
  await confirm.getByRole('button', { name: 'Stop and close' }).click();
  // UI：窗口消失；后台：tmux 会话被结束
  await expect(deck.windowEl(id)).toHaveCount(0);
  await expect.poll(async () => (await deck.board()).windows.some((w) => w.id === id)).toBe(false);
  await expect.poll(() => sb.tmux(['has-session', '-t', `=${terminalId}`]).status).not.toBe(0);
  await deck.screenshot('closed');
});
