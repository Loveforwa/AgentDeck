// TC-40（PL1）：Auto-approve 插件。框里一个假 claude、一个假 codex（e2e/fake-agent/fake-codex.mjs）、一个 shell。
// claude、codex 的 PermissionRequest 钩子真的经 agentdeck-notify 送到主进程，开着 Auto-approve 时钩子回 allow，假 agent 照回答直接放行；
// rm -rf 命中破坏性名单，照常停下，书签变 Needs you。
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { approvalHistory, fakeLog, installCodex, rightClickTitlebar, sendLine } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

async function tokenColor(page: Page, name: string): Promise<string> {
  return page.evaluate((name) => {
    const p = document.createElement('span');
    p.style.backgroundColor = `var(${name})`;
    document.body.appendChild(p);
    const c = getComputedStyle(p).backgroundColor;
    p.remove();
    return c;
  }, name);
}

test('TC-40 Auto-approve on a claude terminal and on the frame: normal commands pass, rm -rf still waits (Needs you)', async ({ deck, sb }) => {
  installCodex(sb);
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/approve');
  const claude = await openFakeClaude(deck, workspaceId);
  const codex = await openTerminal(deck, workspaceId, 'codex');
  await deck.waitForPane(codex.terminalId, /Fake Codex/);
  const shell = await openTerminal(deck, workspaceId, 'shell');
  await deck.waitForPane(shell.terminalId, /e2e\$ *$/m);
  await deck.showAll();
  // codex 的钩子信任了（app-server 报的哈希经 -c hooks.state 带回来）
  expect(fakeLog(deck, codex.terminalId).find((e) => e.kind === 'start')?.['trusted']).toBe(7);
  const claudeMark = deck.windowEl(claude.windowId).locator('.ad-auto-approve-mark');
  const codexMark = deck.windowEl(codex.windowId).locator('.ad-auto-approve-mark');
  const red = await tokenColor(page, '--plugin-auto-approve');
  const attention = await tokenColor(page, '--attention');

  // 1. 右键 claude 标题栏 › PLUGINS › Auto-approve（第一次问一句）
  await rightClickTitlebar(deck, claude.windowId);
  await expect(page.getByRole('menu').first().getByText('PLUGINS')).toBeVisible();
  await page.getByRole('menuitemcheckbox', { name: 'Auto-approve' }).click();
  const ask = page.getByRole('dialog', { name: 'Turn on Auto-approve?' });
  await ask.getByRole('button', { name: 'Turn on' }).click();
  // 终端底边左侧红色小书签
  await expect(claudeMark).toHaveText('Auto-approve');
  await expect(claudeMark).toHaveAttribute('data-state', 'on');
  expect(await claudeMark.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(red);
  await expect(codexMark).toHaveCount(0);
  await deck.screenshot('bookmark');

  // 2. 让 claude 跑一条测试命令：钩子回 allow，直接过，书签闪一下，没进等待
  await deck.focusWindow(claude.windowId);
  await deck.typeLine('ask pnpm test');
  await expect.poll(() => deck.agentLog(claude.terminalId).filter((e) => e.kind === 'auto-approved').length).toBe(1);
  await expect(claudeMark.locator('.ad-auto-approve-flash')).toHaveCount(1);
  await deck.waitForStatus(claude.terminalId, 'running');
  expect(deck.agentLog(claude.terminalId).some((e) => e.kind === 'approved' && e.how === 'key')).toBe(false);
  // 记进 Approval history
  await expect.poll(async () => (await approvalHistory(deck, workspaceId)).map((r) => [r.by, r.request.terminalId, r.request.command])).toEqual([
    ['auto-approve', claude.terminalId, 'pnpm test'],
  ]);
  await deck.screenshot('auto-approved');

  // 3. rm -rf 一个目录：照常停下，书签变橙 “Needs you”，悬停写原因
  await deck.typeLine('done');
  await deck.waitForStatus(claude.terminalId, 'idle');
  await deck.typeLine('ask rm -rf build');
  await deck.waitForStatus(claude.terminalId, 'needs-approval');
  await expect(claudeMark).toHaveText('Needs you');
  await expect(claudeMark).toHaveAttribute('data-state', 'needs-you');
  await expect(claudeMark).toHaveAttribute('title', 'Destructive command: rm -rf build');
  expect(await claudeMark.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(attention);
  await page.waitForTimeout(1500);
  expect(await deck.status(claude.terminalId)).toBe('needs-approval');
  expect(deck.agentLog(claude.terminalId).filter((e) => e.kind === 'auto-approved').length).toBe(1);
  await deck.screenshot('needs-you');
  // 自己在终端里按 1 批准：书签变回红色
  await page.keyboard.press('1');
  await deck.waitForStatus(claude.terminalId, 'running');
  await expect(claudeMark).toHaveText('Auto-approve');

  // 4. 右键框 › PLUGINS › Auto-approve：框标题出现红色小标签，框里每个 agent 终端挂书签（shell 不挂）
  await deck.frameEl('feat/approve').locator('.ad-frame-header').click({ button: 'right', position: { x: 40, y: 12 } });
  await page.getByRole('menuitemcheckbox', { name: 'Auto-approve' }).click();
  // 只在第一次开时问一句，这次直接开
  const tag = deck.frameEl('feat/approve').locator('.ad-auto-approve-tag');
  await expect(tag).toHaveText('Auto-approve');
  expect(await tag.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(red);
  // 标签的中线和项目名的中线对齐（差 1px 以内）
  const middle = async (l: typeof tag) => {
    const b = (await l.boundingBox())!;
    return b.y + b.height / 2;
  };
  const project = deck.frameEl('feat/approve').locator('.ad-frame-project');
  expect(Math.abs((await middle(tag)) - (await middle(project)))).toBeLessThanOrEqual(1);
  await expect(codexMark).toHaveText('Auto-approve');
  await expect(claudeMark).toHaveText('Auto-approve');
  await expect(deck.windowEl(shell.windowId).locator('.ad-auto-approve-mark')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Turn on Auto-approve?' })).toHaveCount(0);
  await deck.screenshot('frame-on');

  // codex 也走 PermissionRequest 钩子回 allow；rm -rf 照常停下
  sendLine(sb, codex.terminalId, 'ask pnpm test');
  await expect.poll(() => fakeLog(deck, codex.terminalId).filter((e) => e.kind === 'auto-approved').map((e) => e['command'])).toEqual(['pnpm test']);
  await expect.poll(async () => (await approvalHistory(deck, workspaceId)).filter((r) => r.request.terminalId === codex.terminalId).map((r) => r.by)).toEqual([
    'auto-approve',
  ]);
  sendLine(sb, codex.terminalId, 'done');
  await deck.waitForStatus(codex.terminalId, 'idle');
  sendLine(sb, codex.terminalId, 'ask rm -rf dist');
  await deck.waitForStatus(codex.terminalId, 'needs-approval');
  await expect(codexMark).toHaveText('Needs you');
  await expect(codexMark).toHaveAttribute('title', 'Destructive command: rm -rf dist');
  expect(fakeLog(deck, codex.terminalId).filter((e) => e.kind === 'approved').length).toBe(1);
  await deck.screenshot('codex-needs-you');
});
