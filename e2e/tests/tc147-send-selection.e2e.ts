// TC-147（CO3，和 TC-109 同一条）：在一个终端里用鼠标选中一段多行 SQL（带 -- 注释），右键 › Send selection to ▸ › 另一个终端，
// 它原样出现在那个终端的输入行里、一行都没执行，焦点跳到那个终端。全程真的：xterm → tmux 的选中（松手经 OSC 52 复制）、
// 白板的右键菜单、粘贴（bracketed paste）经 tmux 进 zsh。
import { existsSync } from 'node:fs';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal } from '../support/flows.ts';

const SQL = [
  'SELECT o.id, o.total, c.email',
  'FROM orders o',
  'JOIN customers c ON c.id = o.customer_id',
  '-- only last week',
  "WHERE o.created_at > now() - interval '7 days';",
];

/** 终端画面上第 row 行、第 col 列那一格的中心（屏幕坐标）。行列从 tmux 的画面算，和 xterm 一格对一格。 */
async function cell(deck: Deck, windowId: string, terminalId: string, row: number, col: number): Promise<{ x: number; y: number }> {
  const [cols, rows] = deck.sb
    .tmux(['display-message', '-p', '-t', `=${terminalId}:`, '#{pane_width} #{pane_height}'])
    .stdout.trim()
    .split(' ')
    .map(Number) as [number, number];
  const box = await deck.windowEl(windowId).locator('.xterm-screen').boundingBox();
  if (!box) throw new Error('terminal screen not visible');
  return { x: box.x + (col + 0.5) * (box.width / cols), y: box.y + (row + 0.5) * (box.height / rows) };
}

test('TC-147 select multi-line SQL with the mouse, Send selection to ▸ another terminal: it lands unchanged and is not run', async ({ deck }) => {
  test.skip(!existsSync('/bin/zsh'), 'the target terminal is zsh (bracketed paste on by default)');
  await deck.launch();
  const { page } = deck;
  // 源：bash 打印 SQL；目标：一个跑 zsh 的自定义命令终端（像数据库 TUI 一样是 custom），都散放
  const source = await openTerminal(deck, null, 'shell', undefined, { x: 40, y: 40 });
  const target = await openTerminal(deck, null, 'custom', 'zsh -f', { x: 660, y: 40 });
  await deck.waitForPane(target.terminalId, /[%$] *$/m);
  // 100% 缩放：白板缩放不是 100% 时 xterm 的鼠标坐标会偏（IS-82），拖选会选到上面几行
  await page.keyboard.press('Meta+0');

  await deck.focusWindow(source.windowId);
  await deck.typeLine("cat <<'EOF'");
  for (const line of SQL) await deck.typeLine(line);
  await deck.typeLine('EOF');
  await deck.waitForPane(source.terminalId, /^WHERE o\.created_at/m);

  // 1. 拖选输出的五行（不是 heredoc 回显的 “> …”）：tmux 进 copy-mode 选中，松手复制
  const lines = deck.sb.tmux(['capture-pane', '-p', '-t', `=${source.terminalId}:`]).stdout.split('\n');
  const first = lines.findIndex((l) => l === SQL[0]);
  const last = lines.findIndex((l, i) => i > first && l === SQL.at(-1));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(last).toBe(first + SQL.length - 1);
  const from = await cell(deck, source.windowId, source.terminalId, first, 0);
  // tmux 的选中不含松手那一格，拖到行尾后面一格
  const to = await cell(deck, source.windowId, source.terminalId, last, SQL.at(-1)!.length);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  // 白板拿到的“选中的文字”就是这五行（tmux 松手后经 OSC 52 发来）
  await expect
    .poll(() => page.evaluate((id) => (window as unknown as { __board: { selectionOf(id: string): string } }).__board.selectionOf(id), source.windowId))
    .toBe(SQL.join('\n'));
  await deck.screenshot('selected');

  // 2. 在源终端里右键：Copy · Paste · Send selection to ▸，子菜单里有目标终端
  await page.mouse.click(to.x, to.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Board' });
  await expect(menu.getByRole('menuitem', { name: /^Copy/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Paste/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /^Send selection to/ }).hover();
  const sub = page.getByRole('menu', { name: 'Send selection to' });
  await expect(sub.getByText('NOT IN A WORKSPACE')).toBeVisible();
  await expect(sub.getByRole('menuitem', { name: /^New terminal here…/ })).toBeVisible();
  await deck.screenshot('menu');
  await sub.getByRole('menuitem', { name: /^zsh( |$)/ }).click();

  // 3. 焦点跳到目标；SQL 原样出现在 zsh 的输入行里，没有执行（没有报错、没有新的提示符）
  await expect.poll(async () => (await deck.board()).focusedId).toBe(target.windowId);
  const pane = await deck.waitForPane(target.terminalId, /interval '7 days';/);
  await page.waitForTimeout(500);
  const after = deck.pane(target.terminalId);
  expect(after).toBe(pane);
  expect(after).not.toMatch(/command not found|parse error|no such file/);
  const tail = after.trimEnd().split('\n').slice(-SQL.length);
  expect(tail.slice(1)).toEqual(SQL.slice(1));
  expect(tail[0]!.endsWith(SQL[0]!)).toBe(true);
  // 源终端没被动过（没有多出命令）
  expect(deck.pane(source.terminalId)).not.toMatch(/command not found/);
  await deck.screenshot('sent');
});
