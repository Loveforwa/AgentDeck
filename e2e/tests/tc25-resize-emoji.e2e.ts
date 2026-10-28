// TC-25 终端一边出字一边改窗口大小（拖右下角、双击标题栏放大再还原），字显示正常：不变空白，emoji 占两格，后面的字不重叠、不断开，
// 和 tmux 里的一样。后台：改大小松手后才通知 tmux 新的行列数；xterm 回滚 1000、字符宽度按 Unicode 11。
// 出字的是 fake-agent/emoji-stream.mjs（在框里的 Shell 里跑，像 agent 吐回答），不是真 claude；真 claude 的回答要人再看一眼。
import { expect, test } from '../support/fixtures.ts';
import { openTerminal, setupWorktree } from '../support/flows.ts';
import { fakeScript, xtermOf } from '../support/g1.ts';
import { makeRepo } from '../support/repo.ts';

const EMOJI = ['✅', '❌', '🚀', '🧪'];

test('TC-25 resize and maximize a terminal while it prints emoji: never blank, emoji take two cells, matches tmux', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'api');
  const page = await deck.launch();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/emoji');
  const t = await openTerminal(deck, workspaceId, 'shell');
  await deck.showAll();
  await deck.waitForPane(t.terminalId, /e2e\$/);
  const size = () =>
    sb
      .tmux(['display-message', '-p', '-t', `=${t.terminalId}:`, '#{pane_width}x#{pane_height}'])
      .stdout.trim();
  const xterm = () => xtermOf(page, t.windowId);
  // 后台：回滚 1000，Unicode 11
  const x0 = (await xterm())!;
  expect(x0.scrollback).toBe(1000);
  expect(x0.unicode).toBe('11');
  expect(size()).toBe(`${x0.cols}x${x0.rows}`);

  // 1. 让它回答（一直出字，大约 10 秒）
  await deck.focusWindow(t.windowId);
  await deck.typeLine(`clear; ${fakeScript('emoji-stream.mjs', '10', '50')}`);
  await deck.waitForPane(t.terminalId, /Pros 4:/);
  const nonBlank = async () => ((await xterm())?.lines.some((l) => /Pros|Cons|Speed|Tests/.test(l)) ?? false);
  expect(await nonBlank()).toBe(true);

  // 2. 回答过程中拖窗口右下角改大小：拖动中 tmux 的行列数不变、画面不空；松手后才变成新的行列数
  const before = size();
  const handle = deck.windowEl(t.windowId).locator('.ad-window-resize--se');
  const hb = (await handle.boundingBox())!;
  const h0 = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
  await page.mouse.move(h0.x, h0.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(h0.x + i * 25, h0.y + i * 15, { steps: 3 });
    await page.waitForTimeout(120);
    expect(size()).toBe(before);
    expect(await nonBlank()).toBe(true);
  }
  await deck.screenshot('dragging');
  await page.mouse.up();
  await expect.poll(async () => {
    const x = await xterm();
    return x ? `${x.cols}x${x.rows}` : '';
  }).not.toBe(before);
  await expect.poll(async () => {
    const x = await xterm();
    return x && size() === `${x.cols}x${x.rows}`;
  }).toBe(true);
  expect(await nonBlank()).toBe(true);

  // 双击标题栏放大，再双击还原：每次都跟着改 tmux 的行列数，画面不空
  const title = deck.windowEl(t.windowId).locator('.ad-window-titlebar');
  const enlarged = size();
  await title.dblclick({ position: { x: 120, y: 10 } });
  await expect.poll(async () => (await deck.board()).windows.find((w) => w.id === t.windowId)!.restoreRect).not.toBeNull();
  await expect.poll(size).not.toBe(enlarged);
  await expect.poll(async () => {
    const x = await xterm();
    return x && size() === `${x.cols}x${x.rows}`;
  }).toBe(true);
  expect(await nonBlank()).toBe(true);
  await deck.screenshot('maximized');
  await title.dblclick({ position: { x: 120, y: 10 } });
  await expect.poll(async () => (await deck.board()).windows.find((w) => w.id === t.windowId)!.restoreRect).toBeNull();
  await expect.poll(size).toBe(enlarged);
  expect(await nonBlank()).toBe(true);

  // 3. 等回答打完，看 emoji 后面的字
  await deck.waitForPane(t.terminalId, /^END$/m, 30_000);
  await expect
    .poll(async () => {
      const x = await xterm();
      return x?.lines.some((l) => l === 'END') ?? false;
    })
    .toBe(true);
  // UI：xterm 的屏幕和 tmux 的一行对一行一样（emoji 后面的字不重叠、不断开，和系统终端里一样）
  const tmuxLines = () =>
    sb
      .tmux(['capture-pane', '-p', '-t', `=${t.terminalId}:`])
      .stdout.split('\n')
      .map((l) => l.trimEnd());
  await expect
    .poll(async () => {
      const x = (await xterm())!;
      const a = x.lines.map((l) => l.trimEnd());
      const b = tmuxLines().slice(0, x.rows);
      while (b.length < a.length) b.push('');
      return JSON.stringify(a) === JSON.stringify(b);
    })
    .toBe(true);
  const x = (await xterm())!;
  // 每个 emoji 占两格：这一格宽 2，下一格宽 0（被占掉），再下一格是后面的字
  let seen = 0;
  for (const [y, row] of x.cells.entries()) {
    for (let col = 0; col < row.length; col++) {
      const [ch, w] = row[col]!;
      if (!EMOJI.includes(ch)) continue;
      seen++;
      expect(w, `row ${y} col ${col} ${ch}`).toBe(2);
      expect(row[col + 1]![1], `cell after ${ch}`).toBe(0);
      expect(row[col + 2]![0], `text after ${ch}`).toBe(' ');
      expect(row[col + 3]![0]).toMatch(/\S/);
    }
  }
  expect(seen).toBeGreaterThan(4);
  // 一行的内容和程序打的一样（没有吞字、错位）
  const sample = x.lines.find((l) => /🚀 Speed \d+: 2x on cold start ✅ done/.test(l));
  expect(sample).toBeTruthy();
  // 没有 IS-39 那种渲染报错（loadCell / isWrapped）
  expect(errors.filter((e) => /loadCell|isWrapped|Cannot read properties/.test(e))).toEqual([]);
  await deck.screenshot('final-text');
});
