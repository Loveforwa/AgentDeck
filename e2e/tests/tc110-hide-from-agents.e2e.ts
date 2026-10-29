// TC-110（AH11 的后台部分）：勾了 Hide from agents 的数据库终端，agent 列不出、读不了、打不进；没勾的照常；
// list_terminals、list_windows 返回给 agent 的东西里没有命令里写明的密码。
// LA1（New terminal ▸ Custom command… 对话框、Hide from agents 的勾、命令里带密码时的说明和灰掉的 Open）还没做：
// 这里 Hide from agents 直接写进窗口数据（TerminalWindowData.hideFromAgents，就是那个勾存的地方），第 3–5 步的界面不测。
// harlequin、lazysql、pgcli 是假程序（e2e/fake-agent/fake-tui.mjs）。
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { fakeLog, installTui, mcpCall } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

type Listed = { terminals: { id: string; command: string; self: boolean }[] };

test('TC-110 a terminal hidden from agents is not listed, read or typed into; no password reaches the agent', async ({ deck, sb }) => {
  for (const t of ['harlequin', 'lazysql', 'pgcli']) installTui(sb, t);
  const repo = makeRepo(sb, 'shop');
  const page = await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/db');
  const claude = await openFakeClaude(deck, workspaceId);
  const harlequin = await openTerminal(deck, workspaceId, 'custom', 'harlequin -P dev');
  const lazysql = await openTerminal(deck, workspaceId, 'shell', 'lazysql');
  // 命令里写明了密码的两个（LA1 做好后对话框会挡住它们；这里直接开，看 list_terminals 怎么报）
  const url = await openTerminal(deck, workspaceId, 'custom', 'pgcli postgres://app:secret@db.internal/shop');
  const env = await openTerminal(deck, workspaceId, 'shell', 'PGPASSWORD=secret pgcli -h db.internal shop');
  for (const t of [harlequin, lazysql, url, env]) await deck.waitForPane(t.terminalId, /AgentDeck e2e fake/);

  // 前提：harlequin 勾着 Hide from agents（存进窗口数据，白板半秒后保存，MCP 每次读保存的白板）
  await page.evaluate(
    (id) => (window as unknown as { __board: { updateData(id: string, patch: object): void } }).__board.updateData(id, { hideFromAgents: true }),
    harlequin.windowId,
  );
  await expect
    .poll(async () => {
      const saved = await page.evaluate(() =>
        (window as unknown as { agentdeck: { board: { load(): Promise<{ windows: { id: string; data: { hideFromAgents?: boolean } | null }[] }> } } }).agentdeck.board.load(),
      );
      return saved.windows.find((w) => w.id === harlequin.windowId)?.data?.hideFromAgents ?? false;
    })
    .toBe(true);
  await deck.showAll();
  await deck.screenshot('terminals');

  // 1. claude 调 list_terminals：没有 harlequin；按 id 调 read_terminal、send_to_terminal 都拒绝
  const listed = await mcpCall(sb, claude.terminalId, 'list_terminals');
  expect(listed.isError, listed.text).toBe(false);
  const ids = (listed.json as Listed).terminals.map((t) => t.id);
  expect(ids).not.toContain(harlequin.terminalId);
  expect(ids).toEqual(expect.arrayContaining([claude.terminalId, lazysql.terminalId, url.terminalId, env.terminalId]));
  const read = await mcpCall(sb, claude.terminalId, 'read_terminal', { terminal_id: harlequin.terminalId });
  expect(read.isError).toBe(true);
  expect(read.text).toBe('The user hid this terminal from agents');
  const send = await mcpCall(sb, claude.terminalId, 'send_to_terminal', { terminal_id: harlequin.terminalId, text: 'DROP TABLE orders;' });
  expect(send.isError).toBe(true);
  expect(send.text).toBe('The user hid this terminal from agents');
  // list_windows 也不列它
  const windows = await mcpCall(sb, claude.terminalId, 'list_windows');
  expect(windows.isError, windows.text).toBe(false);
  expect(windows.text).not.toContain(harlequin.terminalId);
  // 一个键都没进 harlequin
  await page.waitForTimeout(500);
  expect(fakeLog(deck, harlequin.terminalId).filter((e) => e.kind === 'key' || e.kind === 'paste')).toEqual([]);
  expect(deck.pane(harlequin.terminalId)).not.toContain('DROP TABLE');

  // 2. lazysql（没勾）：能列、能读、能打字
  const lread = await mcpCall(sb, claude.terminalId, 'read_terminal', { terminal_id: lazysql.terminalId });
  expect(lread.isError, lread.text).toBe(false);
  expect((lread.json as { lines: string }).lines).toContain('lazysql (AgentDeck e2e fake)');
  const lsend = await mcpCall(sb, claude.terminalId, 'send_to_terminal', { terminal_id: lazysql.terminalId, text: 'SELECT 1;' });
  expect(lsend.isError, lsend.text).toBe(false);
  await expect.poll(() => fakeLog(deck, lazysql.terminalId).filter((e) => e.kind === 'line').map((e) => e['text'])).toEqual(['SELECT 1;']);

  // 后台：list_terminals、list_windows 的返回里都没有 secret 这个字符串。
  // 注意 TerminalInfo.command 是 tmux 的 pane_current_command（前台进程名，这里是 node，真 pgcli 是 pgcli / python），
  // 不是启动命令，所以 “scheme://用户:密码@ 换成 ***” 在这个字段上实际碰不到；换算本身（redactCommand）有单元测试
  const byId = new Map((listed.json as Listed).terminals.map((t) => [t.id, t.command]));
  expect(byId.get(url.terminalId)).not.toContain('secret');
  expect(byId.get(env.terminalId)).not.toContain('secret');
  expect(listed.text).not.toContain('secret');
  expect(windows.text).not.toContain('secret');
  await deck.screenshot('after');
});
