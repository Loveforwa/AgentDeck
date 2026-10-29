// TC-109（CO3）：把 agent 写的多行 SQL 送进数据库终端，只贴不跑。框里一个假 codex（e2e/fake-agent/fake-codex.mjs，`sql` 画一段带
// -- 注释的多行 SELECT，像 codex 的回答）、一个假 harlequin（自定义命令，fake-tui.mjs：开着 bracketed paste，粘贴进“查询编辑器”）、
// 一个假 claude；框外散放一个 Shell。用鼠标在 codex 里选中 SQL，右键 codex 的标题栏 › Send selection to ▸ › harlequin。
// 列表以 CO3 为准（docs/components.md 的 ContextMenus）：按框分组，agent、shell、自定义命令终端都列——用例原文“不列 agent 终端”是 CO3 之前的写法。
// harlequin · shop dev 这个名字是 LA1 的启动预设起的（还没做），这里用 Rename 的标题 “shop dev” 代替。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { fakeLog, installCodex, installTui, rightClickTitlebar, sendLine } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

const SQL = [
  'SELECT o.id, o.total, c.email',
  'FROM orders o',
  'JOIN customers c ON c.id = o.customer_id',
  '-- only last week',
  "WHERE o.created_at > now() - interval '7 days';",
];

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

const selectionOf = (deck: Deck, windowId: string) =>
  deck.page.evaluate((id) => (window as unknown as { __board: { selectionOf(id: string): string } }).__board.selectionOf(id), windowId);

test('TC-109 select multi-line SQL in codex, titlebar › Send selection to ▸ harlequin: it lands in the editor unchanged and is not run', async ({ deck, sb }) => {
  installCodex(sb);
  installTui(sb, 'harlequin');
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/sql');
  const codex = await openTerminal(deck, workspaceId, 'codex');
  const harlequin = await openTerminal(deck, workspaceId, 'custom', 'harlequin -P dev');
  const claude = await openFakeClaude(deck, workspaceId);
  const frame = (await deck.board()).frames[0]!.rect;
  const shell = await openTerminal(deck, null, 'shell', undefined, { x: frame.x, y: frame.y + frame.h + 200 });
  await page.evaluate(
    (id) => (window as unknown as { __board: { renameWindow(id: string, t: string): void } }).__board.renameWindow(id, 'shop dev'),
    harlequin.windowId,
  );
  await deck.waitForPane(harlequin.terminalId, /Query editor/);
  await deck.waitForPane(shell.terminalId, /e2e\$ *$/m);
  // codex 输出一段 SQL
  sendLine(sb, codex.terminalId, 'sql');
  await deck.waitForPane(codex.terminalId, /^WHERE o\.created_at/m);
  // 100% 缩放（别的缩放见 is82-zoomed-mouse），把 codex 挪进视口
  await page.keyboard.press('Meta+0');
  await page.evaluate((id) => (window as unknown as { __board: { focusWindow(id: string): void } }).__board.focusWindow(id), codex.windowId);
  await expect(deck.windowEl(codex.windowId).locator('.xterm-screen')).toBeInViewport({ ratio: 0.9 });

  // 1. 在 codex 终端里用鼠标选中那段 SQL
  const lines = sb.tmux(['capture-pane', '-p', '-t', `=${codex.terminalId}:`]).stdout.split('\n');
  const first = lines.findIndex((l) => l === SQL[0]);
  const last = lines.findIndex((l, i) => i > first && l === SQL.at(-1));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(last).toBe(first + SQL.length - 1);
  const from = await cell(deck, codex.windowId, codex.terminalId, first, 0);
  const to = await cell(deck, codex.windowId, codex.terminalId, last, SQL.at(-1)!.length);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => selectionOf(deck, codex.windowId)).toBe(SQL.join('\n'));
  await deck.screenshot('selected');

  // 2. 右键 codex 的标题栏 › Send selection to ▸：按框分组，这个框在前，散放的在最后
  const tb = (await deck.windowEl(codex.windowId).locator('.ad-window-titlebar').boundingBox())!;
  await page.mouse.click(tb.x + 60, tb.y + tb.height / 2, { button: 'right' });
  const send = page.getByRole('menuitem', { name: /^Send selection to/ });
  await expect(send).toBeEnabled();
  await send.hover();
  const sub = page.getByRole('menu', { name: 'Send selection to' });
  await expect(sub.getByRole('menuitem', { name: /^harlequin/ })).toContainText('shop dev');
  await expect(sub.getByRole('menuitem', { name: /^claude/ })).toBeVisible();
  await expect(sub.getByText('NOT IN A WORKSPACE')).toBeVisible();
  await expect(sub.getByRole('menuitem', { name: /^bash/ })).toBeVisible();
  // 源终端自己不列
  await expect(sub.getByRole('menuitem', { name: /^codex/ })).toHaveCount(0);
  await deck.screenshot('submenu');

  // 3. 选 harlequin · shop dev：编辑器里原样的多行 SQL（换行、-- 注释都在），没执行（没按回车），焦点转到 harlequin
  await sub.getByRole('menuitem', { name: /^harlequin/ }).click();
  await expect.poll(async () => (await deck.board()).focusedId).toBe(harlequin.windowId);
  await expect.poll(() => fakeLog(deck, harlequin.terminalId).filter((e) => e.kind === 'paste').map((e) => String(e['text']).replace(/\r\n?/g, '\n'))).toEqual([SQL.join('\n')]);
  const pane = await deck.waitForPane(harlequin.terminalId, /interval '7 days';/);
  for (const l of SQL) expect(pane).toContain(l);
  await page.waitForTimeout(500);
  expect(fakeLog(deck, harlequin.terminalId).filter((e) => e.kind === 'key' || e.kind === 'line')).toEqual([]);
  // 不经过 MCP：codex 的终端里也没多出东西
  expect(fakeLog(deck, codex.terminalId).filter((e) => e.kind === 'input').map((e) => e['line'])).toEqual(['sql']);
  await deck.screenshot('sent');

  // 4. 不选任何东西，右键标题栏：Send selection to 灰掉
  expect(await selectionOf(deck, claude.windowId)).toBe('');
  await rightClickTitlebar(deck, claude.windowId);
  await expect(page.getByRole('menuitem', { name: /^Send selection to/ })).toBeDisabled();
  await deck.screenshot('disabled');
});
