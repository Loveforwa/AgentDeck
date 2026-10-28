// PL6 Auto-resume（TC-78、TC-82 的 claude 部分）：假 claude 像真的一样撞上 5 小时额度（会话记录里一行 rate_limit + StopFailure 钩子），
// 主进程的 LimitService 认出来、按账号归组；终端底边挂书签，点开卡片改这一次续跑的话。
//   1. AgentDeck 来续（像 codex；这里是关了自己续的 claude：quota_auto_resume_disabled）：书签 Paused · resumes …，改了的话就是到点
//      真的打进终端的那一句。
//   2. claude 自己续（2.1.234 起）：书签 claude resumes …（灰），改了的话马上送进 claude，到点 claude 发这一句、不发自己的 continue；
//      AgentDeck 不再发别的。真 claude 是不是这样还没核对（DR-84），假 claude 照文档的说法做。
// 恢复时间设在 40 多秒后，AGENTDECK_LIMIT_GRACE_MS=0、AGENTDECK_RESUME_STAGGER_MS=0（默认是恢复后 1 分钟、隔 30 秒）。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal } from '../support/flows.ts';

const EDITED = 'Limit reset. Finish the migration first, then run pnpm test.';

type Limits = { key: string; agent: string; terminals: { terminalId: string; state: string; owner: string; message?: string | null; messageDelivered?: boolean }[] }[];

async function fastLimits(deck: Deck) {
  deck.sb.env['AGENTDECK_LIMIT_GRACE_MS'] = '0';
  deck.sb.env['AGENTDECK_RESUME_STAGGER_MS'] = '0';
  await deck.launch();
}

async function fakeClaude(deck: Deck) {
  const t = await openTerminal(deck, null, 'claude', undefined, { x: 40, y: 40 });
  await deck.waitForPane(t.terminalId, /Fake Claude/);
  await deck.waitForStatus(t.terminalId, 'idle');
  return t;
}

const limits = (deck: Deck) =>
  deck.page.evaluate(() => (window as unknown as { agentdeck: { limits: { list(): Promise<Limits> } } }).agentdeck.limits.list());

/** 按键直接经 tmux 送进去（不经过界面，焦点不动）。 */
function sendLine(deck: Deck, terminalId: string, text: string) {
  deck.sb.tmux(['send-keys', '-t', `=${terminalId}:`, '-l', text]);
  deck.sb.tmux(['send-keys', '-t', `=${terminalId}:`, 'Enter']);
}

test('TC-78 limit hit → bookmark “Paused · resumes …” → edit the message → at the reset the edited text is what gets typed', async ({ deck }) => {
  await fastLimits(deck);
  const { page } = deck;
  const t = await fakeClaude(deck);
  const win = deck.windowEl(t.windowId);
  const mark = win.locator('.ad-auto-resume-mark');

  // 右键标题栏 › PLUGINS › Auto-resume（默认关）
  await win.locator('.ad-window-titlebar').click({ button: 'right', position: { x: 80, y: 12 } });
  await page.getByRole('menuitemcheckbox', { name: 'Auto-resume' }).click();
  await expect.poll(async () => ((await deck.board()).windows.find((w) => w.id === t.windowId)?.data as { autoResume?: boolean }).autoResume).toBe(true);
  // 开着但没撞上：不挂书签
  await expect(mark).toHaveCount(0);

  await deck.focusWindow(t.windowId);
  await deck.typeLine('limit 45 noauto');
  await deck.waitForPane(t.terminalId, /Usage limit reached/);
  await expect(mark).toHaveAttribute('data-state', 'paused', { timeout: 30_000 });
  await expect(mark).toHaveText(/^Paused · resumes \d{1,2}:\d\d[ap]m$/);
  await expect(mark).toHaveAttribute('title', /^Stopped by the usage limit/);
  // 后台：LimitService 列着它，AgentDeck 来续
  await expect.poll(async () => (await limits(deck)).flatMap((a) => a.terminals).find((x) => x.terminalId === t.terminalId)?.owner).toBe('auto-resume');
  await deck.screenshot('paused');

  // 点书签 → 卡片：预填默认的话，改掉，⌘↩ 保存
  await mark.click();
  const card = page.getByRole('dialog', { name: 'Auto-resume' });
  const box = card.getByLabel('Message');
  await expect(box).toHaveValue(/^Your usage limit has reset\./);
  await expect(card.getByRole('button', { name: 'Resume now' })).toBeDisabled();
  await box.fill(EDITED);
  await box.press('Meta+Enter');
  await expect.poll(async () => (await limits(deck))[0]?.terminals[0]?.message).toBe(EDITED);
  await expect(card.getByRole('button', { name: 'Reset to default' })).toBeVisible();
  await deck.screenshot('card-edited');

  // 到点：打进终端的就是改过的那一句（bracketed paste + 回车），假 claude 把它当提示词开始干活
  await expect
    .poll(() => deck.agentLog(t.terminalId).filter((e) => e.kind === 'prompt').map((e) => e.line), { timeout: 90_000, message: 'the resume message typed into claude' })
    .toEqual([EDITED]);
  await deck.waitForStatus(t.terminalId, 'running');
  await expect(mark).toHaveAttribute('data-state', 'resuming');
  await expect(mark).toHaveText('Resuming');
  await deck.screenshot('resuming');

  // 这一轮做完：账号从列表里消失，书签收起
  sendLine(deck, t.terminalId, 'done');
  await expect(mark).toHaveCount(0, { timeout: 30_000 });
  expect(await limits(deck)).toEqual([]);
  // 只发了这一句（没有另外的默认续跑）
  expect(deck.agentLog(t.terminalId).filter((e) => e.kind === 'input').map((e) => e.line)).toEqual(['limit 45 noauto', EDITED, 'done']);
});

test('TC-82 claude resumes by itself: an edited message is given to claude while it waits, and claude sends it at the reset', async ({ deck }) => {
  await fastLimits(deck);
  const { page } = deck;
  const t = await fakeClaude(deck);
  const win = deck.windowEl(t.windowId);
  const mark = win.locator('.ad-auto-resume-mark');

  // Auto-resume 关着也挂书签：claude 自己会续是事实
  await deck.focusWindow(t.windowId);
  await deck.typeLine('limit 45');
  await deck.waitForPane(t.terminalId, /Continuing automatically at/);
  await expect(mark).toHaveAttribute('data-state', 'self-waiting', { timeout: 30_000 });
  await expect(mark).toHaveText(/^claude resumes \d{1,2}:\d\d[ap]m$/);
  await expect(mark).toHaveAttribute('data-tone', 'muted');
  await deck.screenshot('claude-resumes');

  await mark.click();
  const card = page.getByRole('dialog', { name: 'Auto-resume' });
  await expect(card.getByRole('button', { name: 'Don’t resume' })).toHaveCount(0);
  const box = card.getByLabel('Message');
  await box.fill(EDITED);
  await card.getByRole('button', { name: 'Give to claude' }).click();
  // 马上送进去了：假 claude 记着，到点改发它
  await expect.poll(() => deck.agentLog(t.terminalId).filter((e) => e.kind === 'queued-while-limited').map((e) => e.line)).toEqual([EDITED]);
  await expect(box).toHaveJSProperty('readOnly', true);
  await expect(card.getByText(/it sends this instead of its own continue/)).toBeVisible();
  await expect.poll(async () => (await limits(deck))[0]?.terminals[0]?.messageDelivered).toBe(true);
  // 自己送进去的字不算你接手
  expect((await limits(deck))[0]?.terminals[0]?.state).toBe('interrupted');
  await deck.screenshot('claude-given');

  // 到点 claude 自己续：发的是改过的那一句
  await expect
    .poll(() => deck.agentLog(t.terminalId).filter((e) => e.kind === 'self-resume').map((e) => (e as { sent?: string | null }).sent), { timeout: 90_000 })
    .toEqual([EDITED]);
  await expect(mark).toHaveAttribute('data-state', 'self-resuming');
  await expect(mark).toHaveText('claude resuming');
  await deck.screenshot('claude-resuming');
  sendLine(deck, t.terminalId, 'done');
  await expect(mark).toHaveCount(0, { timeout: 30_000 });
  // AgentDeck 只送了那一句，没有另发续跑
  expect(deck.agentLog(t.terminalId).filter((e) => e.kind === 'input').map((e) => e.line)).toEqual(['limit 45', EDITED, 'done']);
});
