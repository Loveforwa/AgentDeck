// TC-68（AH7）：一个 agent 不能往另一个正在等你的终端里打字。A、B 是框里的两个假 claude（都挂着 AgentDeck MCP）；
// B 停在等批准一条 rm 命令。A 调 send_to_terminal 往 B 打 “1” → 拒绝、一个键都没进 B；用户批准 B 之后 A 再发一句，正常送到。
// 收件箱（CR1）还没做：批准走顶栏的 Approve all…（同样经 ApprovalService，有 ApprovalRecord）。
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, setupWorktree } from '../support/flows.ts';
import { approvalHistory, mcpCall } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

test('TC-68 send_to_terminal into a terminal that waits for the user is refused; after the user approves it goes through', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/guard');
  const a = await openFakeClaude(deck, workspaceId);
  const b = await openFakeClaude(deck, workspaceId);
  await deck.showAll();
  await deck.focusWindow(b.windowId);
  await deck.typeLine('ask rm -rf build');
  await deck.waitForStatus(b.terminalId, 'needs-approval');
  await deck.focusWindow(a.windowId);
  const inputs = () => deck.agentLog(b.terminalId).filter((e) => e.kind === 'input' || e.kind === 'approved').length;
  const before = inputs();

  // 1. A：“Use send_to_terminal to type 1 into the other terminal”
  const r = await mcpCall(sb, a.terminalId, 'send_to_terminal', { terminal_id: b.terminalId, text: '1' });
  expect(r.isError).toBe(true);
  expect(r.text).toBe('This terminal is waiting for the user. Use the inbox.');

  // 2. B 仍然停在等批准（黄色 Waiting、Approve all… 里那一条还在），一个键都没进去
  await page.waitForTimeout(1000);
  expect(await deck.status(b.terminalId)).toBe('needs-approval');
  await expect(deck.windowEl(b.windowId).locator('.ad-window-titlebar .ad-window-status--attention')).toHaveText(/^Waiting/);
  expect(inputs()).toBe(before);
  expect(deck.pane(b.terminalId)).not.toMatch(/Allowed/);
  await deck.screenshot('refused');

  // 3. 用户批准 B（顶栏 Approve all…；rm -rf 默认不勾，自己勾上）
  await page.getByRole('button', { name: 'Approve all…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve these requests?' });
  const row = dialog.getByRole('listitem').filter({ hasText: 'rm -rf build' });
  await expect(row).toContainText('Unchecked: this looks destructive.');
  await row.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Approve 1' }).click();
  await deck.waitForStatus(b.terminalId, 'running');
  await expect(dialog).toBeHidden();
  // 后台：批准经过 ApprovalService，有 ApprovalRecord；按键是 ApprovalService 发的 1
  await expect.poll(async () => (await approvalHistory(deck, workspaceId)).map((x) => [x.by, x.request.terminalId, x.request.command])).toEqual([
    ['approve-all', b.terminalId, 'rm -rf build'],
  ]);
  expect(deck.agentLog(b.terminalId).filter((e) => e.kind === 'approved').map((e) => e.how)).toEqual(['key']);

  // 4. 再让 A 给 B 发一句话：B 在跑，正常送进去
  const ok = await mcpCall(sb, a.terminalId, 'send_to_terminal', { terminal_id: b.terminalId, text: 'please also run the linter' });
  expect(ok.isError, ok.text).toBe(false);
  expect(ok.json).toEqual({ sent: true, terminalId: b.terminalId });
  await expect.poll(() => deck.agentLog(b.terminalId).filter((e) => e.kind === 'input').map((e) => e.line)).toContain('please also run the linter');
  await deck.screenshot('sent');
});
