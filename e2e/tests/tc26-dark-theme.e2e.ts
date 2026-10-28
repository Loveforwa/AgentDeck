// TC-26 深色白板上 claude 的字看得清，切换深浅色后跟着变。
// 自动化的是整条链路，不是 claude 自己的画面：
// - claude 的启动参数 --settings 里有 "theme":"auto"（假 claude，看 tmux 窗格的启动命令）；
// - 白板切深浅色（主进程 nativeTheme.themeSource，和系统外观一样改 prefers-color-scheme）时，白板 tokens、终端主题跟着变；
// - 终端组件向 tmux 发 CSI ? 997 ; 1|2 n，tmux 转给打开了 ?2031 的程序；程序再问背景色（OSC 11）拿到的是新的背景——
//   claude 的 auto 主题就是这样换字色的。用 fake-agent/theme-probe.mjs 扮演这个程序，记下收到的通知和背景色。
// 真 claude 的问题标题、选项、输入框在深色下是不是浅色字、深灰底，要人看（假 claude 画不出 claude 的主题）。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal } from '../support/flows.ts';
import { fakeScript, xtermOf } from '../support/g1.ts';

async function setTheme(deck: Deck, theme: 'dark' | 'light') {
  await deck.app.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t;
  }, theme);
  await expect.poll(() => deck.page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark');
}

/** "rgb:1616/1616/1515" 或 "#161615" → 0–1 的亮度。 */
function lightness(color: string): number {
  const rgb = color.startsWith('rgb:')
    ? color.slice(4).split('/').map((h) => parseInt(h.slice(0, 2), 16))
    : color.startsWith('#')
      ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
      : (color.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const [r = 0, g = 0, b = 0] = rgb;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

test('TC-26 switching the board between dark and light: claude starts with theme auto, terminals get the 997 report and the new background', async ({ deck, sb }) => {
  const page = await deck.launch();
  // Playwright 默认把 prefers-color-scheme 模拟成 light；去掉模拟，让主进程的 nativeTheme 说了算（和系统外观一样）
  await page.emulateMedia({ colorScheme: null });
  // 1. 白板切到深色，新开 claude
  await setTheme(deck, 'dark');
  const claude = await openFakeClaude(deck, null);
  // 后台：启动参数 --settings 里有 "theme":"auto"
  const start = sb.tmux(['display-message', '-p', '-t', `=${claude.terminalId}:`, '#{pane_start_command}']).stdout;
  expect(start).toContain('--settings');
  expect(start).toMatch(/\\?"theme\\?":\\?"auto\\?"/);

  // 扮演 claude 的 auto 主题：打开 ?2031，收到 997 就重新问背景色
  const log = join(sb.root, 'theme.log');
  const entries = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; mode?: number; value?: string }) : []);
  const probe = await openTerminal(deck, null, 'shell', undefined, { x: 40, y: 480 });
  await deck.waitForPane(probe.terminalId, /e2e\$/);
  sb.tmux(['send-keys', '-t', `=${probe.terminalId}:`, '-l', fakeScript('theme-probe.mjs', log)]);
  sb.tmux(['send-keys', '-t', `=${probe.terminalId}:`, 'Enter']);
  await deck.waitForPane(probe.terminalId, /Theme probe/);
  await page.keyboard.press('Meta+0');
  // 启动时问到的背景色是深色
  await expect.poll(() => entries().filter((e) => e.kind === 'bg').length).toBeGreaterThan(0);
  const darkBg = entries().filter((e) => e.kind === 'bg')[0]!.value!;
  expect(lightness(darkBg)).toBeLessThan(0.3);
  // UI：白板和终端都是深色
  const ground = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ground').trim());
  expect(lightness(await ground())).toBeLessThan(0.3);
  await expect.poll(async () => lightness((await xtermOf(page, claude.windowId))?.theme.background ?? '#ffffff')).toBeLessThan(0.3);
  await deck.screenshot('dark');

  // 3. 不关终端，切到浅色
  const n0 = entries().length;
  await setTheme(deck, 'light');
  // 后台：程序收到 CSI ? 997 ; 2 n（浅色），再问背景色拿到浅色
  await expect.poll(() => entries().slice(n0).some((e) => e.kind === 'report' && e.mode === 2)).toBe(true);
  await expect.poll(() => entries().slice(n0).filter((e) => e.kind === 'bg').map((e) => lightness(e.value!) > 0.7)).toContain(true);
  expect(lightness(await ground())).toBeGreaterThan(0.7);
  await expect.poll(async () => lightness((await xtermOf(page, claude.windowId))?.theme.background ?? '#000000')).toBeGreaterThan(0.7);
  await deck.waitForPane(probe.terminalId, /theme: light/);
  await deck.screenshot('light');

  // 再切回深色：又收到 997 ; 1，背景色又是深色
  const n1 = entries().length;
  await setTheme(deck, 'dark');
  await expect.poll(() => entries().slice(n1).some((e) => e.kind === 'report' && e.mode === 1)).toBe(true);
  await expect.poll(() => entries().slice(n1).filter((e) => e.kind === 'bg').map((e) => lightness(e.value!) < 0.3)).toContain(true);
  expect(lightness(await ground())).toBeLessThan(0.3);
  await expect.poll(async () => lightness((await xtermOf(page, claude.windowId))?.theme.background ?? '#ffffff')).toBeLessThan(0.3);
  await deck.waitForPane(probe.terminalId, /theme: dark/);
  // 最后一条通知是深色（白板上开着几个终端时 tmux 会收到每个终端各报一次，所以不数条数）
  const reports = entries().slice(n0).filter((e) => e.kind === 'report').map((e) => e.mode);
  expect(reports.indexOf(2)).toBeGreaterThanOrEqual(0);
  expect(reports.lastIndexOf(1)).toBeGreaterThan(reports.indexOf(2));
  expect(reports[reports.length - 1]).toBe(1);
  await deck.screenshot('dark-again');
});
