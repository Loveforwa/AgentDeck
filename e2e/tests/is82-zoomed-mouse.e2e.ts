// IS-82：白板缩放不是 100% 时，单击终端里的链接、拖选都不偏。
// 白板用 CSS transform 缩放，xterm 换算鼠标位置时用缩放后的位置、没缩放的格子宽高，以前缩到 60% 时会点到、选到上面几行
// （packages/ui/widgets/terminal/src/zoom.ts 修）。这里每行一个不同的地址、一段不同的文字，点错一行就能看出来。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal } from '../support/flows.ts';
import { cellCenter } from '../support/h2.ts';

/** 在 shell 里打印 n 行：“row-07 http://localhost:4107/p07”。 */
async function printRows(deck: Deck, terminalId: string, n: number): Promise<void> {
  await deck.typeLine(`for i in $(seq 1 ${n}); do printf 'row-%02d http://localhost:41%02d/p%02d\\n' $i $i $i; done`);
  await deck.waitForPane(terminalId, new RegExp(`^row-${String(n).padStart(2, '0')} `, 'm'));
}

/** 这一行在 tmux 画面上的行号。 */
function rowOf(deck: Deck, terminalId: string, text: string): number {
  const lines = deck.sb.tmux(['capture-pane', '-p', '-t', `=${terminalId}:`]).stdout.split('\n');
  const row = lines.findIndex((l) => l.startsWith(text));
  if (row < 0) throw new Error(`"${text}" is not on the screen`);
  return row;
}

const zoomTo = (deck: Deck, z: number) =>
  deck.page.evaluate((z) => (window as unknown as { __board: { zoomTo(z: number): void } }).__board.zoomTo(z), z);

for (const zoom of [0.6, 1.4]) {
  test(`IS-82 at ${Math.round(zoom * 100)}% zoom a click on a link in a terminal opens that line’s address and a drag selects that line`, async ({ deck }) => {
    const page = await deck.launch();
    const shell = await openTerminal(deck, null, 'shell', undefined, { x: 40, y: 40 });
    await deck.waitForPane(shell.terminalId, /\$ *$/m);
    await deck.focusWindow(shell.windowId);
    await printRows(deck, shell.terminalId, 9);
    await zoomTo(deck, zoom);
    await deck.showAll();
    await zoomTo(deck, zoom);
    await expect.poll(async () => (await deck.board()).viewport.zoom).toBeCloseTo(zoom, 2);

    // 1. 单击第 7 行的地址：打开的是 p07，不是上面一行的 p06
    await deck.clickTerminalText(shell.windowId, shell.terminalId, 'http://localhost:4107/p07');
    const browserId = await deck.waitForWindow((w) => w.type === 'browser');
    await expect.poll(async () => (await deck.board()).windows.find((w) => w.id === browserId)?.data['url']).toBe('http://localhost:4107/p07');
    await deck.screenshot('link-clicked');

    // 2. 拖选第 4 行的 “row-04”：选中的就是这几个字（tmux 松手经 OSC 52 发来）
    await deck.focusWindow(shell.windowId);
    // 等过 tmux 的双击、三击间隔，免得聚焦那一下和拖选的按下被算成多击（选成一个词、一整行）
    await page.waitForTimeout(800);
    const row = rowOf(deck, shell.terminalId, 'row-04 ');
    const from = await cellCenter(deck, shell.windowId, shell.terminalId, row, 0);
    const to = await cellCenter(deck, shell.windowId, shell.terminalId, row, 'row-04'.length);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate((id) => (window as unknown as { __board: { selectionOf(id: string): string } }).__board.selectionOf(id), shell.windowId))
      .toBe('row-04');
    await deck.screenshot('selected');
  });
}
