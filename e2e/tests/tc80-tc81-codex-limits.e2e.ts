// TC-80、TC-81（PL5 + PL6 Auto-resume，codex）：假 codex（e2e/fake-agent/fake-codex.mjs）像真的一样撞上 5 小时额度——
// 会话记录里 token_count 的 rate_limits.primary 用到 100%、task_complete 带 error usage_limit_exceeded（codex 撞额度没有钩子，
// LimitService 一直看着 codex 的会话记录）。三个 codex 用同一个 CODEX_HOME（沙盒的 ~/.codex），是同一个账号。
// AGENTDECK_LIMIT_GRACE_MS=5000、AGENTDECK_RESUME_STAGGER_MS=2000（默认 1 分钟、30 秒）。
// Prompt queue（PL3）2026-10-28 退役：空闲的那个不再排提示词，用例里 “1 queued”“Queue · 1 · sends …” 那些不测。
// 收件箱（CR1）还没做：⌘J 看收件箱那一条不测；整个账号的 Don’t resume 是收件箱的按钮，这里直接调它背后的 limits.cancel。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal, setupWorktree } from '../support/flows.ts';
import { fakeLog, installCodex, limitsList, sendLine } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

const GRACE = 5000;
const STAGGER = 2000;

async function launchWithCodex(deck: Deck, branch: string, names: string[]) {
  installCodex(deck.sb);
  deck.sb.env['AGENTDECK_LIMIT_GRACE_MS'] = String(GRACE);
  deck.sb.env['AGENTDECK_RESUME_STAGGER_MS'] = String(STAGGER);
  const repo = makeRepo(deck.sb, 'shop');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, branch);
  const out: Record<string, { windowId: string; terminalId: string }> = {};
  for (const n of names) {
    const t = await openTerminal(deck, workspaceId, 'codex');
    await deck.waitForPane(t.terminalId, /Fake Codex/);
    await page.evaluate(({ id, n }) => (window as unknown as { __board: { renameWindow(id: string, t: string): void } }).__board.renameWindow(id, n), { id: t.windowId, n });
    out[n] = t;
  }
  await deck.showAll();
  // 右键框 › PLUGINS › Auto-resume（框里的 agent 终端都开）
  await deck.frameEl(branch).locator('.ad-frame-header').click({ button: 'right', position: { x: 40, y: 12 } });
  await page.getByRole('menuitemcheckbox', { name: 'Auto-resume' }).click();
  await expect.poll(async () => (await deck.board()).frames[0] as unknown as { autoResume?: boolean }).toEqual(expect.objectContaining({ autoResume: true }));
  return { page, workspaceId, t: out };
}

/** 假 codex 收到的“提示词”（AgentDeck 续跑时 bracketed paste + 回车送进来的那一句也算），带时间。 */
const prompts = (deck: Deck, id: string) =>
  fakeLog(deck, id)
    .filter((e) => e.kind === 'prompt')
    .map((e) => ({ at: Date.parse(String(e['at'])), line: String(e['line']) }));

test('TC-80 three codex terminals on one account: one group, Don’t resume one, staggered resumes, the idle one gets nothing, cancel stops all', async ({ deck, sb }) => {
  const { page, t } = await launchWithCodex(deck, 'feat/limits', ['T5', 'T6', 'Review docs']);
  const { T5, T6 } = t as Record<'T5' | 'T6', { windowId: string; terminalId: string }>;
  const docs = t['Review docs']!;
  const mark = (x: { windowId: string }) => deck.windowEl(x.windowId).locator('.ad-auto-resume-mark');
  // Review docs 跑过一轮，现在空闲（它自己的会话记录里没有 limit）
  sendLine(sb, docs.terminalId, 'work');
  sendLine(sb, docs.terminalId, 'done');
  await deck.waitForStatus(docs.terminalId, 'idle');

  // 1. T5、T6 在跑，先后撞上（恢复时间相同）
  const reset = Math.floor(Date.now() / 1000) + 30;
  for (const x of [T5, T6]) sendLine(sb, x.terminalId, 'work');
  await deck.waitForStatus(T6.terminalId, 'running');
  sendLine(sb, T5.terminalId, `limit @${reset}`);
  await expect(mark(T5)).toHaveAttribute('data-state', 'paused', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  sendLine(sb, T6.terminalId, `limit @${reset}`);
  await expect(mark(T6)).toHaveAttribute('data-state', 'paused', { timeout: 30_000 });

  // 2. 一组（一个账号键 codex + CODEX_HOME），三个终端：T5、T6 被打断，Review docs 当时空闲；各自的书签
  const codexHome = `${sb.home}/.codex`;
  await expect.poll(async () => (await limitsList(deck)).map((a) => [a.agent, a.key.startsWith(`codex:${codexHome}:`), a.terminals.length])).toEqual([['codex', true, 3]]);
  const states = async () => Object.fromEntries((await limitsList(deck))[0]?.terminals.map((x) => [x.terminalId, x.state]) ?? []);
  expect(await states()).toEqual({ [T5.terminalId]: 'interrupted', [T6.terminalId]: 'interrupted', [docs.terminalId]: 'idle' });
  // 按被打断的先后：T5 先续
  const list = (await limitsList(deck))[0]!;
  const at = (id: string) => Date.parse(list.terminals.find((x) => x.terminalId === id)!.resumeAt ?? '');
  expect(at(T6.terminalId) - at(T5.terminalId)).toBeGreaterThanOrEqual(STAGGER);
  expect(at(T5.terminalId)).toBeGreaterThanOrEqual(reset * 1000 + GRACE);
  await expect(mark(T5)).toHaveText(/^Paused · resumes \d{1,2}:\d\d[ap]m$/);
  await expect(mark(T6)).toHaveText(/^Paused · resumes \d{1,2}:\d\d[ap]m$/);
  await expect(mark(docs)).toHaveText(/^Limit · resets \d{1,2}:\d\d[ap]m$/);
  await expect(mark(docs)).toHaveAttribute('data-state', 'idle');
  await deck.screenshot('three-paused');

  // 3. 恢复前去掉 T6：它的卡片里 Don’t resume（整个账号的勾选列表在收件箱里，CR1）
  await mark(T6).click();
  const card = page.getByRole('dialog', { name: 'Auto-resume' });
  await card.getByRole('button', { name: 'Don’t resume' }).click();
  await expect(mark(T6)).toHaveAttribute('data-state', 'skipped');
  await expect(mark(T6)).toHaveText('Skipped');
  expect((await states())[T6.terminalId]).toBe('skipped');
  await page.keyboard.press('Escape');

  // 4. 等到恢复（恢复时间 + 5 秒宽限）：T5 收到续跑的话；T6、Review docs 什么都没收到
  await expect.poll(() => prompts(deck, T5.terminalId).length, { timeout: 90_000, message: 'T5 resumed' }).toBe(2);
  const resumed = prompts(deck, T5.terminalId)[1]!;
  expect(resumed.line).toMatch(/^Your usage limit has reset\./);
  expect(resumed.at).toBeGreaterThanOrEqual(reset * 1000 + GRACE);
  await expect(mark(T5)).toHaveText('Resuming');
  await page.waitForTimeout(STAGGER + 2000);
  expect(prompts(deck, T6.terminalId).map((p) => p.line)).toEqual(['work']);
  expect(prompts(deck, docs.terminalId).map((p) => p.line)).toEqual(['work']);
  await deck.screenshot('t5-resuming');
  // T5 这一轮做完：这一组了结，书签都收起
  sendLine(sb, T5.terminalId, 'done');
  await expect.poll(() => limitsList(deck), { timeout: 30_000 }).toEqual([]);
  for (const x of [T5, T6, docs]) await expect(mark(x)).toHaveCount(0, { timeout: 30_000 });

  // （后台：错开）再撞一次，这次 T6 先、T5 后，两个都续：按被打断的先后，间隔 ≥ 2 秒
  const reset2 = Math.floor(Date.now() / 1000) + 20;
  for (const x of [T5, T6]) sendLine(sb, x.terminalId, 'work');
  await deck.waitForStatus(T5.terminalId, 'running');
  sendLine(sb, T6.terminalId, `limit @${reset2}`);
  await expect(mark(T6)).toHaveAttribute('data-state', 'paused', { timeout: 30_000 });
  await page.waitForTimeout(1000);
  sendLine(sb, T5.terminalId, `limit @${reset2}`);
  await expect(mark(T5)).toHaveAttribute('data-state', 'paused', { timeout: 30_000 });
  await expect.poll(() => prompts(deck, T5.terminalId).length, { timeout: 90_000 }).toBe(4);
  await expect.poll(() => prompts(deck, T6.terminalId).length, { timeout: 30_000 }).toBe(3);
  const t6At = prompts(deck, T6.terminalId)[2]!.at;
  const t5At = prompts(deck, T5.terminalId)[3]!.at;
  expect(t5At - t6At).toBeGreaterThanOrEqual(STAGGER - 100);
  expect(prompts(deck, docs.terminalId).length).toBe(1);
  for (const x of [T5, T6]) sendLine(sb, x.terminalId, 'done');
  await expect.poll(() => limitsList(deck), { timeout: 30_000 }).toEqual([]);

  // 5. 再撞一次，这次整个账号 Don’t resume（收件箱的按钮 = limits.cancel）：到点三个都不发，这一组消失
  const reset3 = Math.floor(Date.now() / 1000) + 15;
  for (const x of [T5, T6]) sendLine(sb, x.terminalId, 'work');
  await deck.waitForStatus(T6.terminalId, 'running');
  for (const x of [T5, T6]) sendLine(sb, x.terminalId, `limit @${reset3}`);
  await expect.poll(async () => (await limitsList(deck))[0]?.terminals.length ?? 0, { timeout: 30_000 }).toBe(3);
  const key = (await limitsList(deck))[0]!.key;
  await page.evaluate((k) => (window as unknown as { agentdeck: { limits: { cancel(k: string): Promise<void> } } }).agentdeck.limits.cancel(k), key);
  await expect.poll(() => limitsList(deck), { timeout: 15_000 }).toEqual([]);
  for (const x of [T5, T6, docs]) await expect(mark(x)).toHaveCount(0, { timeout: 30_000 });
  // 等过恢复时间 + 宽限 + 错开：一个都没发
  await page.waitForTimeout(Math.max(0, reset3 * 1000 + GRACE + 2 * STAGGER + 2000 - Date.now()));
  expect(prompts(deck, T5.terminalId).length).toBe(5);
  expect(prompts(deck, T6.terminalId).length).toBe(4);
  expect(prompts(deck, docs.terminalId).length).toBe(1);
  await deck.screenshot('cancelled');
});

/** TC-81 的前提：一个 codex 开着 Auto-resume，撞上额度，书签 Paused。记下 limits.changed 的每一次列表（书签一闪而过时看后台）。 */
async function pausedCodex(deck: Deck) {
  const { sb } = deck;
  const { page, t } = await launchWithCodex(deck, 'feat/takeover', ['codex']);
  const codex = t['codex']!;
  await page.evaluate(() => {
    const w = window as unknown as { __limits: unknown[]; agentdeck: { on(type: string, cb: (e: { limits: unknown }) => void): unknown } };
    w.__limits = [];
    w.agentdeck.on('limits.changed', (e) => w.__limits.push(e.limits));
  });
  const mark = deck.windowEl(codex.windowId).locator('.ad-auto-resume-mark');
  sendLine(sb, codex.terminalId, 'work');
  await deck.waitForStatus(codex.terminalId, 'running');
  const reset = Math.floor(Date.now() / 1000) + 15;
  sendLine(sb, codex.terminalId, `limit @${reset}`);
  await expect(mark).toHaveAttribute('data-state', 'paused', { timeout: 30_000 });
  return { page, codex, mark, reset };
}

test('TC-81 after the limit you take over: the terminal is marked took-over and nothing is sent at the reset', async ({ deck }) => {
  const { page, codex, mark, reset } = await pausedCodex(deck);
  await deck.screenshot('paused');

  // 1. 恢复前单击这个终端，输入 “let’s do something else” 回车（真的键盘）
  await deck.focusWindow(codex.windowId);
  await deck.typeLine("let's do something else");
  // 后台：LimitService 把它记成 took-over（状态机的 noteInput），带着这个状态发了最后一次 limits.changed，然后这一组（只有它）消失
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __limits: { terminals: { terminalId: string; state: string }[] }[][] }).__limits.flatMap((l) => l.flatMap((a) => a.terminals.map((x) => x.state))),
      ),
    )
    .toContain('took-over');
  await expect.poll(() => limitsList(deck)).toEqual([]);
  // 书签写着 “Not resumed · you took over” 停几秒再收起（见下一个测试）
  await expect(mark).toHaveCount(0, { timeout: 30_000 });

  // 2. 等到恢复时间 + 宽限之后：AgentDeck 没往这个终端发东西（sendKeys 没调用：假 codex 只收到你打的那几行）
  await page.waitForTimeout(Math.max(0, reset * 1000 + GRACE + 4000 - Date.now()));
  expect(fakeLog(deck, codex.terminalId).filter((e) => e.kind === 'input').map((e) => e['line'])).toEqual(['work', `limit @${reset}`, "let's do something else"]);
  await deck.screenshot('after-reset');
});

// IS-155：LimitService 了结一个账号时先带最后的状态发一次 limits.changed、紧接着又发一次去掉它的列表（同一个 tick）；
// 界面（LimitsModel）把了结的终端按最后的样子多留 LINGER_MS（5 秒）再收起。“Resumed” 也一样。
test('TC-81 the bookmark says “Not resumed · you took over” for a few seconds before it goes away', async ({ deck }) => {
  const { codex, mark } = await pausedCodex(deck);
  await deck.focusWindow(codex.windowId);
  await deck.typeLine("let's do something else");
  await expect(mark).toHaveText('Not resumed · you took over', { timeout: 10_000 });
  await expect(mark).toHaveAttribute('data-state', 'took-over');
  await deck.screenshot('took-over');
  const shownAt = Date.now();
  await expect(mark).toHaveCount(0, { timeout: 15_000 });
  expect(Date.now() - shownAt).toBeGreaterThan(3000);
});
