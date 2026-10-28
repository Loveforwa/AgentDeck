// TC-42（X3）：顶栏 Approve all…。三个终端在等批准：假 claude 要 touch 一个文件、假 codex 要 rm -rf（破坏性）、
// 另一个假 claude 不认按键（ask-stuck，像“允许一次”没生效）。列表列出每一条，破坏性的默认不勾；批不了的标 Couldn’t approve 留在列表里。
// 按键是 ApprovalService 真的经 tmux 发进去的（claude 发 1，codex 发 y），批准后 agent 继续，有 ApprovalRecord（approve-all）。
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { approvalHistory, fakeLog, installCodex, sendLine } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

test('TC-42 Approve all… lists every request, leaves the destructive one unchecked, marks the one it couldn’t approve', async ({ deck, sb }) => {
  installCodex(sb);
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/all');
  const claude = await openFakeClaude(deck, workspaceId);
  const codex = await openTerminal(deck, workspaceId, 'codex');
  await deck.waitForPane(codex.terminalId, /Fake Codex/);
  const stuck = await openFakeClaude(deck, workspaceId);
  await deck.showAll();

  // 前提：三个都在等批准
  sendLine(sb, claude.terminalId, 'ask touch notes.txt');
  sendLine(sb, codex.terminalId, 'ask rm -rf build');
  sendLine(sb, stuck.terminalId, 'ask-stuck pnpm lint');
  for (const t of [claude, codex, stuck]) await deck.waitForStatus(t.terminalId, 'needs-approval');
  await expect(page.locator('.ad-topbar-waiting')).toHaveText(/3 waiting/);

  // 1. 点顶栏 Approve all…（不设快捷键：按钮上没有）
  const button = page.getByRole('button', { name: 'Approve all…' });
  await expect(button).toHaveAttribute('title', 'Review and approve 3 waiting permission requests');
  expect(await button.getAttribute('aria-keyshortcuts')).toBeNull();
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Approve these requests?' });

  // 2. 列表：每条写 agent · 项目 · 分支、命令；rm -rf 默认不勾并写原因；按钮是 Approve 2
  const rows = dialog.getByRole('listitem');
  await expect(rows).toHaveCount(3);
  const row = (text: string) => rows.filter({ hasText: text });
  await expect(row('touch notes.txt')).toContainText('claude');
  await expect(row('touch notes.txt').getByRole('checkbox')).toBeChecked();
  await expect(row('pnpm lint').getByRole('checkbox')).toBeChecked();
  await expect(row('rm -rf build')).toContainText('codex');
  await expect(row('rm -rf build').getByRole('checkbox')).not.toBeChecked();
  await expect(row('rm -rf build')).toContainText('Unchecked: this looks destructive.');
  await expect(dialog.getByRole('button', { name: 'Approve 2' })).toBeEnabled();
  await deck.screenshot('list');

  // 3. 点 Approve
  await dialog.getByRole('button', { name: 'Approve 2' }).click();
  // claude 继续了（按键 1 真的进去了、PostToolUse 到了）
  await deck.waitForStatus(claude.terminalId, 'running');
  expect(deck.agentLog(claude.terminalId).filter((e) => e.kind === 'approved').map((e) => e.how)).toEqual(['key']);
  // 批不了的那条（2 秒内没离开等待）标 Couldn’t approve，留在列表里；rm -rf 照常等着
  await expect(row('pnpm lint')).toHaveAttribute('data-outcome', 'couldnt-approve', { timeout: 15_000 });
  await expect(row('pnpm lint')).toContainText('Couldn’t approve');
  await expect(rows).toHaveCount(2);
  await expect(row('touch notes.txt')).toHaveCount(0);
  await expect(page.getByText('Approved 1 request · 2 still need you')).toBeVisible();
  await deck.screenshot('after-approve');
  expect(await deck.status(stuck.terminalId)).toBe('needs-approval');
  expect(await deck.status(codex.terminalId)).toBe('needs-approval');
  // codex 一个键都没收到；ask-stuck 的 claude 收到了 1（只是没生效）
  expect(fakeLog(deck, codex.terminalId).filter((e) => e.kind === 'approved' || e.kind === 'key-ignored')).toEqual([]);
  expect(deck.agentLog(stuck.terminalId).filter((e) => e.kind === 'key-ignored').map((e) => (e as { key?: string }).key)).toEqual(['1']);
  // 记录：只有批成了的那条，算 approve-all
  expect((await approvalHistory(deck, workspaceId)).map((r) => [r.by, r.request.terminalId])).toEqual([['approve-all', claude.terminalId]]);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.ad-topbar-waiting')).toHaveText(/2 waiting/);
});
