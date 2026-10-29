// IS-05 终端手感（packages/tmux-host/AGENTS.md「需要人工确认」里能让机器核对的部分）。全程真的：xterm.js（WebGL）→ tmux（-L 沙盒）→ 程序。
// 程序是 fake-agent/key-probe.mjs：记下它真正收到的每一段字节，按命令画颜色和框线、发响铃和 OSC 9。
// - 颜色和框线：xterm 缓冲区里每格的字、宽度、颜色（16 色、256 色、真彩色前景背景）和样式；tmux 里存的还是真彩色；截图里真的画出了那几个颜色。
// - 按键：Esc、Shift+Enter（程序申请了扩展按键时是 CSI 13;2u）、Option+字母（Meta）、方向键、⌃C、⌘V 粘贴多行（bracketed paste，不提交）；
//   接回显示后马上按 Esc 的延迟。
// - 滚轮和回滚：聚焦的终端里滚轮进 tmux 回滚，直接打字退出回滚、字进输入行；滚回底部自动退出。
// - 拖选复制：拖选松手就进系统剪贴板（OSC 52），⌘V 到别的终端粘出来；按住 Option 拖是 xterm 自己的选中，⌘C 复制。
// - 第二个客户端：测试自己用沙盒的 tmux socket attach 同一个会话（node-pty），两边输入输出互相看得到，大小跟最近有输入的那边。
// - 完成提醒：程序发的响铃和经 tmux 透传的 OSC 9 到了 xterm；假 claude 做完一轮标题栏 Idle · now。
// 只能人工的：触控板滚动的惯性和速度、真 claude 的配色和 / 菜单、Terminal.app / iTerm2 里 attach 的颜色、从访达拖文件、打字有没有延迟感。
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal } from '../support/flows.ts';
import {
  cellCenter,
  colorIn,
  focusTerminal,
  hex,
  openProbe,
  paneVar,
  probeChunks,
  probeLog,
  readClipboard,
  saveClipboard,
  watchXtermEvents,
  writeClipboard,
  xtermCells,
  xtermEvents,
} from '../support/h2.ts';
import { attachInPty, type PtySession } from '../support/system-terminal.ts';

const BOX = ['╭────────────╮', '│ 中文 ▶ ✓ ● │', '╰────────────╯', '┌──┬──┐ ═══ ║', '└──┴──┘'];

test('IS-05 colours and box-drawing characters render: 16 / 256 / true colour, styles, CJK width, box lines', async ({ deck }) => {
  const page = await deck.launch();
  const probe = await openProbe(deck, { x: 40, y: 40 });
  await page.keyboard.press('Meta+0');
  await focusTerminal(deck, probe.windowId);
  await deck.typeLine('colors');
  await deck.waitForPane(probe.terminalId, /└──┴──┘/);

  // xterm 缓冲区：每一行的字和 tmux 里一样，框线字符原样
  let view: Awaited<ReturnType<typeof xtermCells>> = null;
  await expect
    .poll(async () => {
      view = await xtermCells(page, probe.windowId);
      return view?.lines.some((l) => l === BOX.at(-1)) ?? false;
    })
    .toBe(true);
  const v = view!;
  expect(v.renderer).toBe('canvas');
  const rowOf = (re: RegExp) => v.lines.findIndex((l) => re.test(l));
  const boxTop = rowOf(/^╭─+╮$/);
  expect(v.lines.slice(boxTop, boxTop + BOX.length)).toEqual(BOX);
  // 中文一个字占两格，▶ ✓ ● 和框线一格：框的右边对齐
  const cjk = v.cells[boxTop + 1]!;
  expect(cjk.map((c) => c.ch).join('')).toBe('│ 中文 ▶ ✓ ● │');
  expect(cjk.find((c) => c.ch === '中')!.width).toBe(2);
  for (const ch of ['▶', '✓', '●', '│']) expect(cjk.find((c) => c.ch === ch)!.width).toBe(1);
  expect(cjk.length).toBeGreaterThanOrEqual(14);
  expect(v.cells[boxTop]![13]!.ch).toBe('╮');
  expect(cjk[13]!.ch).toBe('│');

  // 颜色：找每个词第一个字所在的格子
  const cellAt = (word: string) => {
    const y = v.lines.findIndex((l) => l.includes(word));
    expect(y, word).toBeGreaterThanOrEqual(0);
    return v.cells[y]![v.lines[y]!.indexOf(word)]!;
  };
  expect(cellAt('RED')).toMatchObject({ fgMode: 'palette', fg: 1 });
  expect(cellAt('GREEN')).toMatchObject({ fgMode: 'palette', fg: 2 });
  expect(cellAt('YELLOW')).toMatchObject({ fgMode: 'palette', fg: 3 });
  expect(cellAt('BLUE')).toMatchObject({ fgMode: 'palette', fg: 4 });
  expect(cellAt('BRIGHT-MAGENTA')).toMatchObject({ fgMode: 'palette', fg: 13 });
  expect(cellAt('P202')).toMatchObject({ fgMode: 'palette', fg: 202 });
  // 真彩色经过 tmux 还是真彩色（AgentDeck 的客户端 attach 时带 -T RGB；不带时会降成 256 色的 202）
  expect(cellAt('RGB-FF6400')).toMatchObject({ fgMode: 'rgb', fg: 0xff6400 });
  expect(cellAt('BG-0050A0')).toMatchObject({ bgMode: 'rgb', bg: 0x0050a0 });
  expect(cellAt('BOLD').bold).toBe(true);
  expect(cellAt('UNDER').underline).toBe(true);
  expect(cellAt('ITALIC').italic).toBe(true);
  expect(cellAt('Key probe')).toMatchObject({ fgMode: 'default', bold: false });
  // tmux 里存的也是真彩色
  const escaped = deck.sb.tmux(['capture-pane', '-p', '-e', '-t', `=${probe.terminalId}:`]).stdout;
  expect(escaped).toContain('38;2;255;100;0');
  expect(escaped).toContain('48;2;0;80;160');

  // 截图：WebGL 真的把这几个颜色画出来了（背景色整格一样，前景字有抗锯齿，取最接近的像素）
  await deck.screenshot('colors');
  const word = async (w: string) => {
    const y = v.lines.findIndex((l) => l.includes(w));
    const x = v.lines[y]!.indexOf(w);
    const a = await cellCenter(deck, probe.windowId, probe.terminalId, y, x);
    return { x: a.x - a.w / 2, y: a.y - a.h / 2, width: a.w * w.length, height: a.h };
  };
  // 截图有色彩管理（显示器色域），差几十以内算同一个颜色；背景色要占这块区域的大半
  const bg = await colorIn(page, await word('BG-0050A0'), 0x0050a0, 40);
  expect(bg.best).toBeLessThanOrEqual(40);
  expect(bg.share).toBeGreaterThan(0.4);
  // 前景字很细、有抗锯齿，最接近的像素也差一些
  const fg = await colorIn(page, await word('RGB-FF6400'), 0xff6400, 60);
  expect(fg.best).toBeLessThanOrEqual(60);
  // 框线连不连、字形对不对看截图（colors.png）
});

test('IS-05 keys reach the program: Esc, Shift+Enter, Option+letter, arrows, ⌃C, multi-line ⌘V paste stays unsubmitted', async ({ deck }) => {
  const page = await deck.launch();
  const restoreClipboard = await saveClipboard(deck);
  try {
    // ext：像 claude、codex 那样申请了扩展按键（modifyOtherKeys 2）；plain：像 bash、zsh 那样没申请
    const probe = await openProbe(deck, { x: 40, y: 40 }, '--ext');
    const plain = await openProbe(deck, { x: 40, y: 520 });
    await page.keyboard.press('Meta+0');
    await expect.poll(() => paneVar(deck, probe.terminalId, '#{pane_key_mode}')).toBe('Ext 2');
    await expect.poll(() => paneVar(deck, plain.terminalId, '#{pane_key_mode}')).toBe('VT10x');
    const since = (t: { terminalId: string }) => probeChunks(deck, t.terminalId).length;
    const after = (t: { terminalId: string }, n: number) =>
      probeChunks(deck, t.terminalId)
        .slice(n)
        .map((c) => c.hex)
        .join('');

    const keys: [string, string, string][] = [
      // [按键, ext 收到的, plain 收到的]
      ['Escape', '\x1b', '\x1b'],
      // Shift+Enter：xterm 发 CSI 13;2u（keys.ts）；申请了的程序原样收到，没申请的收到普通回车
      ['Shift+Enter', '\x1b[13;2u', '\r'],
      // Option 当 Meta（macOptionIsMeta）：没申请的收到 ESC b；申请了的 tmux 用 CSI u 发（98 = b，3 = Alt）
      ['Alt+b', '\x1b[98;3u', '\x1bb'],
      ['ArrowUp', '\x1b[A', '\x1b[A'],
      ['ArrowDown', '\x1b[B', '\x1b[B'],
      // ⌃C：modifyOtherKeys 2 下 ⌃ 加字母也用 CSI u（99 = c，5 = Ctrl）
      ['Control+c', '\x1b[99;5u', '\x03'],
    ];
    for (const [t, col] of [
      [probe, 1],
      [plain, 2],
    ] as const) {
      await focusTerminal(deck, t.windowId);
      for (const k of keys) {
        const n = since(t);
        await page.keyboard.press(k[0]);
        await expect.poll(() => after(t, n), { message: `${k[0]} → ${t === probe ? 'ext' : 'plain'}` }).toBe(hex(k[col]));
      }
      // Esc 单独一段到（escape-time 0，不和后面的键粘在一起、不等）
      expect(probeChunks(deck, t.terminalId).some((c) => c.hex === '1b')).toBe(true);
    }
    await focusTerminal(deck, probe.windowId);

    // ⌘V 粘贴多行：bracketed paste 一整段，换行变成回车，没有提交（没有 line）
    const text = 'first pasted line\nsecond pasted line\nthird pasted line';
    await writeClipboard(deck, text);
    const lines0 = probeLog(deck, probe.terminalId).filter((e) => e.kind === 'line').length;
    await page.keyboard.press('Meta+v');
    await expect.poll(() => probeLog(deck, probe.terminalId).filter((e) => e.kind === 'paste').map((e) => e.text)).toEqual([text.replace(/\n/g, '\r')]);
    await deck.waitForPane(probe.terminalId, /pasted 3 line\(s\)/);
    expect(probeLog(deck, probe.terminalId).filter((e) => e.kind === 'line').length).toBe(lines0);
    await deck.screenshot('keys');

    // 刚接回显示马上按 Esc：程序立刻收到（xterm 替 tmux 回答了 XTVERSION、OSC 10/11，不会卡 500ms）
    const clients = () => deck.sb.tmux(['list-clients', '-t', `=${probe.terminalId}`, '-F', '#{client_tty}']).stdout.trim().split('\n').filter(Boolean).length;
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      // 平移白板让窗口出视口：显示断开
      await page.evaluate(() => (window as unknown as { __board: { setViewport(v: object, d?: number): void } }).__board.setViewport({ x: -5000, y: -5000, zoom: 1 }, 0));
      await expect.poll(clients).toBe(0);
      await page.evaluate(() => (window as unknown as { __board: { setViewport(v: object, d?: number): void } }).__board.setViewport({ x: 0, y: 0, zoom: 1 }, 0));
      await expect.poll(clients).toBe(1);
      await focusTerminal(deck, probe.windowId);
      const n = since(probe);
      const t0 = Date.now();
      await page.keyboard.press('Escape');
      await expect.poll(() => after(probe, n)).toBe('1b');
      delays.push(probeChunks(deck, probe.terminalId).at(-1)!.t - t0);
    }
    test.info().annotations.push({ type: 'esc-after-attach-ms', description: delays.join(', ') });
    console.log(`[IS-05] Esc right after re-attach reached the program in ${delays.join(', ')} ms`);
    // 问题 1 修好前是 500ms 以上；本机同时跑着别的 e2e，给到 300ms
    expect(Math.min(...delays)).toBeLessThan(300);
  } finally {
    await restoreClipboard();
  }
});

test('IS-05 wheel scrolls back in tmux, typing leaves scrollback, drag-select copies to the clipboard, Option-drag + ⌘C copies', async ({ deck }) => {
  const page = await deck.launch();
  const restoreClipboard = await saveClipboard(deck);
  try {
    const sh = await openTerminal(deck, null, 'shell', undefined, { x: 40, y: 40 });
    const probe = await openProbe(deck, { x: 40, y: 520 });
    await deck.waitForPane(sh.terminalId, /e2e\$/);
    await page.keyboard.press('Meta+0');
    await focusTerminal(deck, sh.windowId);
    await deck.typeLine('seq 1 300');
    await deck.waitForPane(sh.terminalId, /^300\ne2e\$ $/m);
    const inMode = () => paneVar(deck, sh.terminalId, '#{pane_in_mode}');
    const screen = async () => (await xtermCells(page, sh.windowId))?.lines ?? [];

    // 1. 聚焦的终端里滚轮往上：tmux 进回滚，xterm 画的是更早的行
    const box = (await deck.windowEl(sh.windowId).locator('.xterm-screen').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
    await expect.poll(inMode).toBe('1');
    await expect.poll(async () => Number(paneVar(deck, sh.terminalId, '#{scroll_position}'))).toBeGreaterThan(5);
    await expect.poll(async () => (await screen()).includes('300')).toBe(false);
    const top = Number((await screen()).find((l) => /^\d+$/.test(l)));
    expect(top).toBeLessThan(290);
    await deck.screenshot('scrollback');
    // 2. 直接打一个字母：回滚退出，字母出现在提示符后面（不用多按一次）
    await page.keyboard.type('x');
    await expect.poll(inMode).toBe('0');
    await deck.waitForPane(sh.terminalId, /e2e\$ x$/m);
    await page.keyboard.press('Backspace');
    await expect.poll(() => deck.pane(sh.terminalId).trimEnd().split('\n').at(-1)!.trimEnd()).toBe('e2e$');
    // 3. 往上翻一点再滚回底部：自动退出回滚（copy-mode -e）
    for (let i = 0; i < 2; i++) await page.mouse.wheel(0, -120);
    await expect.poll(inMode).toBe('1');
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 120);
    await expect.poll(inMode).toBe('0');

    // 4. 拖选两行，松手：tmux 经 OSC 52 复制，系统剪贴板里就是这两行（不用 ⌘C）
    await deck.typeLine("printf 'alpha-%s\\nbravo-%s\\n' one two");
    await deck.waitForPane(sh.terminalId, /^bravo-two$/m);
    await writeClipboard(deck, 'before drag');
    const lines = deck.sb.tmux(['capture-pane', '-p', '-t', `=${sh.terminalId}:`]).stdout.split('\n');
    const first = lines.lastIndexOf('alpha-one');
    expect(lines[first + 1]).toBe('bravo-two');
    const from = await cellCenter(deck, sh.windowId, sh.terminalId, first, 0);
    const to = await cellCenter(deck, sh.windowId, sh.terminalId, first + 1, 'bravo-two'.length);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => readClipboard(deck)).toBe('alpha-one\nbravo-two');
    expect(await inMode()).toBe('0');
    // ⌘V 到别处（另一个终端）：原样粘出来
    await focusTerminal(deck, probe.windowId);
    await page.keyboard.press('Meta+v');
    await expect.poll(() => probeLog(deck, probe.terminalId).filter((e) => e.kind === 'paste').map((e) => e.text)).toEqual(['alpha-one\rbravo-two']);

    // 5. 按住 Option 拖：xterm 自己的选中（不进 tmux），⌘C 复制
    await focusTerminal(deck, sh.windowId);
    const a = await cellCenter(deck, sh.windowId, sh.terminalId, first, 0);
    const b = await cellCenter(deck, sh.windowId, sh.terminalId, first, 'alpha-one'.length - 1);
    await writeClipboard(deck, 'before option drag');
    await page.keyboard.down('Alt');
    await page.mouse.move(a.x - a.w / 3, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.move(b.x + b.w / 3, b.y, { steps: 2 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const xsel = () =>
      page.evaluate((id) => {
        const el = document.querySelector(`.ad-window-node[data-window-id="${id}"] .ad-terminal__xterm`) as (Element & { agentdeckSession?: { term: { getSelection(): string } } }) | null;
        return el?.agentdeckSession?.term.getSelection() ?? null;
      }, sh.windowId);
    await expect.poll(xsel).toBe('alpha-one');
    expect(await inMode()).toBe('0');
    await deck.screenshot('option-select');
    await page.keyboard.press('Meta+c');
    await expect.poll(() => readClipboard(deck)).toBe('alpha-one');
  } finally {
    await restoreClipboard();
  }
});

test('IS-05 a program that asked for the mouse (like codex) gets the wheel itself: SGR wheel events, no tmux scrollback', async ({ deck }) => {
  const page = await deck.launch();
  const probe = await openProbe(deck, { x: 40, y: 40 }, '--mouse');
  await page.keyboard.press('Meta+0');
  await expect.poll(() => paneVar(deck, probe.terminalId, '#{mouse_any_flag}#{mouse_sgr_flag}')).toMatch(/1$/);
  await focusTerminal(deck, probe.windowId);
  const n = probeChunks(deck, probe.terminalId).length;
  const box = (await deck.windowEl(probe.windowId).locator('.xterm-screen').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -120);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 120);
  // 程序收到 SGR 的滚轮（64 上、65 下），tmux 没进回滚
  const got = () =>
    Buffer.from(
      probeChunks(deck, probe.terminalId)
        .slice(n)
        .map((c) => c.hex)
        .join(''),
      'hex',
    ).toString('latin1');
  await expect.poll(got).toMatch(/\x1b\[<64;\d+;\d+M/);
  await expect.poll(got).toMatch(/\x1b\[<65;\d+;\d+M/);
  expect(paneVar(deck, probe.terminalId, '#{pane_in_mode}')).toBe('0');
});

test('IS-05 a second tmux client on the same session: both see input and output, size follows the latest input', async ({ deck }) => {
  const page = await deck.launch();
  const sh = await openTerminal(deck, null, 'shell', undefined, { x: 40, y: 40 });
  await deck.waitForPane(sh.terminalId, /e2e\$/);
  await page.keyboard.press('Meta+0');
  await focusTerminal(deck, sh.windowId);
  const size = () => paneVar(deck, sh.terminalId, '#{window_width}x#{window_height}');
  const deckSize = size();
  // 测试自己当“系统终端”：用沙盒的 tmux socket attach 同一个会话（不碰 agentdeck、agentdeck-w01-review）
  const tmuxBin = `${deck.sb.root}/sysbin/tmux`;
  let sys: PtySession | null = attachInPty(deck.sb, `${tmuxBin} -L ${deck.sb.tmuxSocket} attach-session -t =${sh.terminalId}`);
  try {
    const clients = () => deck.sb.tmux(['list-clients', '-t', `=${sh.terminalId}`, '-F', '#{client_tty}']).stdout.trim().split('\n').filter(Boolean);
    await expect.poll(() => clients().length).toBe(2);
    // 系统终端里打字：AgentDeck 的窗口里看得到命令和输出；窗口大小跟着系统终端（100×30，window-size latest）
    sys.write('echo from-$((40+2))-pty\r');
    await deck.waitForPane(sh.terminalId, /^from-42-pty$/m);
    await expect.poll(async () => (await xtermCells(page, sh.windowId))?.lines.some((l) => l === 'from-42-pty')).toBe(true);
    await expect.poll(size).toBe('100x30');
    // AgentDeck 里打字：系统终端里看得到；大小回到 AgentDeck 的
    await deck.typeLine('echo from-$((50+5))-deck');
    await expect.poll(() => sys!.text()).toContain('from-55-deck');
    await expect.poll(size).toBe(deckSize);
    // 画面不乱：xterm 屏幕和 tmux 一行对一行
    await expect
      .poll(async () => {
        const x = (await xtermCells(page, sh.windowId))?.lines.map((l) => l.trimEnd()) ?? [];
        const t = deck.sb.tmux(['capture-pane', '-p', '-t', `=${sh.terminalId}:`]).stdout.split('\n').map((l) => l.trimEnd());
        return JSON.stringify(x.slice(0, t.length)) === JSON.stringify(t.slice(0, x.length));
      })
      .toBe(true);
    await deck.screenshot('two-clients');
    // 关掉系统终端：只断开那个客户端，AgentDeck 照常
    sys.close();
    sys = null;
    await expect.poll(() => clients().length).toBe(1);
    await expect(deck.windowEl(sh.windowId).locator('.ad-terminal__notice')).toHaveCount(0);
    await deck.typeLine('echo still-$((1+1))');
    await deck.waitForPane(sh.terminalId, /^still-2$/m);
  } finally {
    sys?.close();
  }
});

test('IS-05 completion notice: bell and passthrough OSC 9 reach xterm; a fake claude that finishes shows Idle · now', async ({ deck }) => {
  const page = await deck.launch();
  const probe = await openProbe(deck, { x: 40, y: 40 });
  const claude = await openFakeClaude(deck, null);
  await page.keyboard.press('Meta+0');
  await watchXtermEvents(page, probe.windowId);
  await focusTerminal(deck, probe.windowId);
  await deck.typeLine('bell');
  await deck.waitForPane(probe.terminalId, /rang the bell/);
  // 响铃一次；DCS tmux; 包着的 OSC 9 经 allow-passthrough 原样到 xterm。不包的 OSC 9 tmux 不转（只认透传）
  await expect.poll(() => xtermEvents(page, probe.windowId)).toEqual(expect.arrayContaining(['bell', 'osc9:key-probe finished']));
  const events = await xtermEvents(page, probe.windowId);
  expect(events.filter((e) => e === 'bell')).toHaveLength(1);
  test.info().annotations.push({ type: 'xterm-events', description: events.join(' | ') });
  console.log(`[IS-05] xterm saw: ${events.join(' | ')}`);
  // 假 claude 做完一轮（Stop 钩子）：标题栏 Idle · now，灰色
  await focusTerminal(deck, claude.windowId);
  await deck.typeLine('work');
  await deck.waitForStatus(claude.terminalId, 'running');
  await expect(deck.windowEl(claude.windowId).locator('.ad-window-status')).toHaveText(/^Running/);
  await deck.typeLine('done all tests pass');
  await deck.waitForStatus(claude.terminalId, 'idle');
  await expect(deck.windowEl(claude.windowId).locator('.ad-window-status')).toHaveText(/^Idle · now$/);
  await expect(deck.windowEl(claude.windowId).locator('.ad-window-status')).toHaveClass(/ad-window-status--muted/);
  await deck.screenshot('finished');
});
