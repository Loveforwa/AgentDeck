// TC-48（AH3）：agent 升级到没核对过的版本，替你按键的功能自动关掉，界面说明原因。
// 假 omp（e2e/fake-agent/fake-pi.mjs --fake-as omp）先报 18.0.4（compat/omp.json 核对到的版本），开着 Auto-approve；
// 换成报 18.12.6 的版本（重写 PATH 里的 omp，修改时间也变了）后重启 AgentDeck。omp 的扩展（真的 agentdeck-pi-extension.mjs）
// 照常报状态：要批准时进 needs-approval，AgentDeck 不发 Up Enter，omp 等你自己按。
// Settings › Agents 页还没做（SettingsDialog 只有 General 等页），那一步只核对它要显示的数据（agents.list 的 report）。
// 第二个测试不刷新页面：重启后 PLUGINS 里的 Auto-approve 直接灰掉（IS-153），保存的开关还在、书签变 Needs you（IS-154）。
import type { Page } from '@playwright/test';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openTerminal, setupWorktree } from '../support/flows.ts';
import { fakeLog, installOmp, rightClickTitlebar } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

type Entry = { key: string; level: string; reason: string | null; verifiedUpTo: string | null; downgrade?: string | null };
type Info = { id: string; version: string | null; report?: { version: string | null; entries: Entry[] } | null };
const ompInfo = async (deck: Deck) =>
  (await deck.page.evaluate(() => (window as unknown as { agentdeck: { agents: { list(): Promise<Info[]> } } }).agentdeck.agents.list())).find((a) => a.id === 'omp')!;

/** 前提：omp 18.0.4 的终端开着 Auto-approve；换成 18.12.6；1. 重启 AgentDeck。 */
async function upgradedOmp(deck: Deck): Promise<{ page: Page; omp: { windowId: string; terminalId: string } }> {
  const { sb } = deck;
  installOmp(sb, '18.0.4');
  const repo = makeRepo(sb, 'shop');
  let page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/omp');
  const omp = await openTerminal(deck, workspaceId, 'omp');
  await deck.waitForPane(omp.terminalId, /Oh My Pi \(AgentDeck e2e fake\) v18\.0\.4/);
  await deck.waitForStatus(omp.terminalId, 'idle');
  expect((await ompInfo(deck)).report?.entries.find((e) => e.key === 'approve-keys')?.level).toBe('yes');
  await rightClickTitlebar(deck, omp.windowId);
  await page.getByRole('menuitemcheckbox', { name: 'Auto-approve' }).click();
  await page.getByRole('dialog', { name: 'Turn on Auto-approve?' }).getByRole('button', { name: 'Turn on' }).click();
  await expect(deck.windowEl(omp.windowId).locator('.ad-auto-approve-mark')).toHaveText('Auto-approve');
  await expect.poll(async () => (await deck.board()).windows.find((w) => w.id === omp.windowId)?.data['autoApprove']).toBe(true);

  installOmp(sb, '18.12.6');
  await deck.quit();
  page = await deck.launch();
  await deck.waitForPane(omp.terminalId, /Oh My Pi/);
  await expect.poll(async () => (await ompInfo(deck)).version).toBe('18.12.6');
  return { page, omp };
}

test('TC-48 omp newer than the checked version: approve keys off with “Untested on 18.12.6”, AgentDeck sends no keys, omp waits for you', async ({ deck }) => {
  const { page, omp } = await upgradedOmp(deck);

  // 2. Settings › Agents › Oh My Pi 要显示的数据：18.12.6、核对到 18.0.4；Approve keys 是 Off · Untested on 18.12.6；状态、历史、用量照常 Yes
  const info = await ompInfo(deck);
  expect(info.report?.version).toBe('18.12.6');
  const entry = (k: string) => info.report!.entries.find((e) => e.key === k)!;
  expect(entry('approve-keys')).toEqual(expect.objectContaining({ level: 'no', downgrade: 'off', reason: 'Untested on 18.12.6', verifiedUpTo: '18.0.4' }));
  for (const k of ['status', 'history', 'usage']) expect(entry(k).level, k).toBe('yes');
  // 后台：ApprovalService 也跟着报告走（omp 不能替你按，原因同一句）
  const support = await page.evaluate(() =>
    (window as unknown as { agentdeck: { approvals: { autoApproveSupport(): Promise<{ agent: string; method: string; note: string | null }[]> } } }).agentdeck.approvals.autoApproveSupport(),
  );
  expect(support.find((s) => s.agent === 'omp')).toEqual(expect.objectContaining({ method: 'unsupported', note: 'Untested on 18.12.6' }));

  // 3. PLUGINS 里 Auto-approve 灰掉、hint 写 Untested on 18.12.6；刷新页面后也一样（不刷新的见下一个测试）
  await page.reload();
  await page.locator('.react-flow').first().waitFor();
  await expect(deck.windowEl(omp.windowId)).toBeVisible();
  await rightClickTitlebar(deck, omp.windowId);
  const item = page.getByRole('menuitemcheckbox', { name: /^Auto-approve/ });
  await expect(item).toBeDisabled();
  await expect(item).toContainText('Untested on 18.12.6');
  await deck.screenshot('menu-after-reload');
  await page.keyboard.press('Escape');

  // 4. 让 omp 跑一条要批准的命令：停在确认框，黄灯；AgentDeck 一个键都不发
  await deck.focusWindow(omp.windowId);
  await deck.typeLine('ask pnpm test');
  await deck.waitForPane(omp.terminalId, /Allow tool: bash/);
  await deck.waitForStatus(omp.terminalId, 'needs-approval');
  await expect(deck.windowEl(omp.windowId).locator('.ad-window-titlebar .ad-window-status--attention')).toHaveText(/^Waiting/);
  await page.waitForTimeout(3000);
  expect(fakeLog(deck, omp.terminalId).filter((e) => e.kind === 'key' || e.kind === 'approved')).toEqual([]);
  expect(await deck.status(omp.terminalId)).toBe('needs-approval');
  await deck.screenshot('waiting');

  // 自己按：↑ 回车选 Approve，omp 接着跑完
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect.poll(() => fakeLog(deck, omp.terminalId).filter((e) => e.kind === 'approved').length).toBe(1);
  await deck.waitForStatus(omp.terminalId, 'idle');
});

// IS-153：界面检测完 agent（白板的 agent 列表到了）再取一次 autoApproveSupport()，不用刷新页面。
// IS-154：主进程按白板恢复时保留开关（restoreTerminalAutoApprove），不按键；书签还在，要批准时变 Needs you（unsupported）。
test('TC-48 right after the restart: PLUGINS greys out Auto-approve and the bookmark turns into Needs you', async ({ deck }) => {
  const { page, omp } = await upgradedOmp(deck);
  await rightClickTitlebar(deck, omp.windowId);
  const item = page.getByRole('menuitemcheckbox', { name: /^Auto-approve/ });
  await expect(item).toBeDisabled({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await deck.focusWindow(omp.windowId);
  await deck.typeLine('ask pnpm test');
  await deck.waitForStatus(omp.terminalId, 'needs-approval');
  const mark = deck.windowEl(omp.windowId).locator('.ad-auto-approve-mark');
  await expect(mark).toHaveText('Needs you', { timeout: 10_000 });
  await expect(mark).toHaveAttribute('title', /^Not supported/);
  await deck.screenshot('needs-you');
  // AgentDeck 一个键都不发
  await page.waitForTimeout(3000);
  expect(fakeLog(deck, omp.terminalId).filter((e) => e.kind === 'key' || e.kind === 'approved')).toEqual([]);
});
