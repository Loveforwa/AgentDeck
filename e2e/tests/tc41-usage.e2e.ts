// TC-41（PL2）：Usage 用量条。框里一个假 claude、一个假 codex，都跑过几轮：
// 假 claude 的 `usage` 命令往它自己的会话记录（$HOME/.claude/projects/<cwd>/<会话 id>.jsonl）写带 message.usage 的回答行，
// 假 codex 每轮往 $CODEX_HOME/sessions/…/rollout-…-<id>.jsonl 写 token_count（含 5 小时、每周额度）。AgentDeck 自己读这些文件。
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { installCodex, rightClickTitlebar, sendLine } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

type Usage = {
  status: string;
  model: string | null;
  total: { input: number; output: number; cacheRead: number } | null;
  context: { tokens: number | null; window: number | null } | null;
  rateLimits: { primary: { usedPercent: number; windowMinutes: number } | null; secondary: { usedPercent: number } | null } | null;
};
const usageOf = (deck: Deck, id: string) =>
  deck.page.evaluate((id) => (window as unknown as { agentdeck: { usage: { get(id: string): Promise<Usage> } } }).agentdeck.usage.get(id), id);

async function turnOnUsage(deck: Deck, windowId: string) {
  await rightClickTitlebar(deck, windowId);
  await deck.page.getByRole('menuitemcheckbox', { name: 'Usage' }).click();
  await expect(deck.windowEl(windowId).locator('.ad-usage-strip')).toBeVisible();
}

test('TC-41 Usage strip on claude and codex: in / out / cache / context, updates each round, drags to the bottom, card with limits, yellow from 85%', async ({ deck, sb }) => {
  installCodex(sb);
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/usage');
  const claude = await openFakeClaude(deck, workspaceId);
  const codex = await openTerminal(deck, workspaceId, 'codex');
  await deck.waitForPane(codex.terminalId, /Fake Codex/);
  await deck.showAll();

  // 前提：两个都跑过几轮
  for (const [i, o, c] of [
    [20, 400, 30_000],
    [10, 600, 52_000],
  ] as const) {
    sendLine(sb, claude.terminalId, 'work');
    sendLine(sb, claude.terminalId, `usage ${i} ${o} ${c}`);
    sendLine(sb, claude.terminalId, 'done');
  }
  for (let n = 0; n < 2; n++) {
    sendLine(sb, codex.terminalId, 'work');
    sendLine(sb, codex.terminalId, 'done');
  }
  await deck.waitForStatus(claude.terminalId, 'idle');
  await deck.waitForStatus(codex.terminalId, 'idle');
  // 后台：读的就是 agent 自己的会话文件（数对得上假 agent 写的）
  await expect.poll(async () => (await usageOf(deck, claude.terminalId)).total).toEqual(expect.objectContaining({ input: 30, output: 1000, cacheRead: 82_000 }));
  const cu = await usageOf(deck, claude.terminalId);
  expect(cu.model).toBe('claude-sonnet-4-5');
  expect(cu.context).toEqual(expect.objectContaining({ tokens: 52_010, window: 200_000 }));
  await expect.poll(async () => (await usageOf(deck, codex.terminalId)).total).toEqual(expect.objectContaining({ input: 1600, output: 100, cacheRead: 400 }));

  // 1. 右键终端 › PLUGINS › Usage：终端上方贴一条
  await turnOnUsage(deck, claude.windowId);
  const strip = deck.windowEl(claude.windowId).locator('.ad-usage-strip');
  await expect(strip).toHaveAttribute('data-position', 'top');
  await expect(strip).toHaveAttribute('data-state', 'ok');
  await expect(strip.locator('[data-field="in"]')).toHaveText('Input 30');
  await expect(strip.locator('[data-field="out"]')).toHaveText('Output 1k');
  await expect(strip.locator('[data-field="cache"]')).toHaveText('Cache 82k');
  await expect(strip.locator('[data-field="ctx"]')).toContainText('52k / 200k');
  await expect(strip.locator('.ad-usage-pct')).toHaveText('26%');
  // 条在窗口上边
  const winBox = (await deck.windowEl(claude.windowId).locator('.ad-window').boundingBox())!;
  expect((await strip.boundingBox())!.y).toBeLessThan(winBox.y + 4);
  await turnOnUsage(deck, codex.windowId);
  const cstrip = deck.windowEl(codex.windowId).locator('.ad-usage-strip');
  await expect(cstrip).toHaveAttribute('data-state', 'ok');
  await expect(cstrip.locator('[data-field="in"]')).toContainText('1.6');
  await deck.screenshot('strips');

  // 2. 让 agent 再跑一轮：条跟着更新
  sendLine(sb, claude.terminalId, 'work');
  sendLine(sb, claude.terminalId, 'usage 5 500 60000');
  sendLine(sb, claude.terminalId, 'done');
  await expect(strip.locator('[data-field="out"]')).toHaveText('Output 1.5k');
  await expect(strip.locator('[data-field="ctx"]')).toContainText('60k / 200k');

  // 3. 拖把手到下边：贴到下边，存进白板
  const grip = strip.locator('.ad-usage-grip');
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, winBox.y + winBox.height * 0.6, { steps: 6 });
  await page.mouse.move(g.x + g.width / 2, winBox.y + winBox.height - 4, { steps: 6 });
  await page.mouse.up();
  await expect(strip).toHaveAttribute('data-position', 'bottom');
  expect((await strip.boundingBox())!.y).toBeGreaterThan(winBox.y + winBox.height - 4);
  await expect
    .poll(async () => {
      const saved = await page.evaluate(() =>
        (window as unknown as { agentdeck: { board: { load(): Promise<{ windows: { id: string; data: Record<string, unknown> | null }[] }> } } }).agentdeck.board.load(),
      );
      return JSON.stringify(saved.windows.find((w) => w.id === claude.windowId)?.data ?? {});
    })
    .toContain('"bottom"');
  await deck.screenshot('bottom');

  // 4. 点条：小卡片（模型、Context window、Last request、Requests）；codex 的卡片有 5 小时 / 每周额度
  await strip.locator('.ad-usage-body').click();
  const card = page.getByRole('dialog', { name: 'Usage details' });
  await expect(card.locator('.ad-usage-card-model')).toHaveText('claude-sonnet-4-5');
  await expect(card).toContainText('Context window 200k');
  await expect(card.locator('[data-row="last"]')).toContainText('Last request');
  await expect(card.locator('[data-row="requests"]')).toContainText('3');
  await deck.screenshot('claude-card');
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await cstrip.locator('.ad-usage-body').click();
  const ccard = page.getByRole('dialog', { name: 'Usage details' });
  await expect(ccard.locator('.ad-usage-card-model')).toHaveText('gpt-test-codex');
  await expect(ccard.locator('[data-row="limit"]')).toHaveCount(2);
  await expect(ccard.locator('[data-row="limit"]').nth(0)).toContainText('5h limit');
  await expect(ccard.locator('[data-row="limit"]').nth(0)).toContainText('88% left');
  await expect(ccard.locator('[data-row="limit"]').nth(1)).toContainText('Weekly limit');
  await expect(ccard.locator('[data-row="limit"]').nth(1)).toContainText('69% left');
  await deck.screenshot('codex-card');
  await page.keyboard.press('Escape');

  // 5. 上下文过了 85%：条变黄
  await expect(strip).not.toHaveClass(/ad-usage-strip--attention/);
  sendLine(sb, claude.terminalId, 'work');
  sendLine(sb, claude.terminalId, 'usage 10 800 175000');
  sendLine(sb, claude.terminalId, 'done');
  await expect(strip.locator('.ad-usage-pct')).toHaveText('88%');
  await expect(strip).toHaveClass(/ad-usage-strip--attention/);
  await expect(strip.locator('[data-field="ctx"]')).toHaveAttribute('data-attention', 'true');
  await deck.screenshot('attention');
});
