// TC-46（AH1，IS-76）：白板上的 claude 用 MCP 的 open_terminals 开 pi、omp、kimi，各带第一条消息，每个都原样收到。
// 调用者是框里的假 claude 终端（测试用它的终端钥匙发 MCP 请求，和 claude 自己调工具发的一样）；pi、omp、kimi 是假程序
// （e2e/fake-agent/fake-pi.mjs、fake-kimi.mjs），按真程序的规矩解析参数、记下收到的第一条消息：
//   pi：消息在启动参数里（位置参数；@ 开头时 AgentDeck 前面加一个空格，不然真 pi 当成文件）；
//   omp：消息在 `--` 之后；
//   kimi：交互模式没有这个参数，AgentDeck 等终端第一次安静下来后替你在输入框里打字、回车（sendAfterReady）。
// 给 shell 的 prompt 不会悄悄丢掉：工具返回错误，不开终端。
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, setupWorktree } from '../support/flows.ts';
import { fakeLog, installKimi, installOmp, installPi, mcpCall } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';

const PELICAN = 'reply with the word PELICAN';
const AT = '@README.md reply with the word HERON';

type Opened = { workspaceId: string | null; lead: string; terminals: { terminalId: string; label: string | null }[] };

test('TC-46 open_terminals opens pi, omp and kimi with a first message; each receives it unchanged, a shell prompt is refused', async ({ deck, sb }) => {
  installPi(sb);
  installOmp(sb);
  installKimi(sb);
  const repo = makeRepo(sb, 'shop');
  await deck.launch();
  const { page } = deck;
  const { workspaceId, path } = await setupWorktree(deck, repo, 'feat/first-message');
  const lead = await openFakeClaude(deck, workspaceId);
  // 三个都被认出来了（菜单里能选）
  const agents = await page.evaluate(() =>
    (window as unknown as { agentdeck: { agents: { list(): Promise<{ id: string; installed: boolean; version: string | null }[]> } } }).agentdeck.agents.list(),
  );
  for (const id of ['pi', 'omp', 'kimi']) expect(agents.find((a) => a.id === id)?.installed, id).toBe(true);

  // 1. claude 调 open_terminals 三次：一个 pi、一个 omp、一个 kimi，第一条消息都是 “reply with the word PELICAN”
  const opened: Record<string, string> = {};
  for (const agent of ['pi', 'omp', 'kimi']) {
    const r = await mcpCall(sb, lead.terminalId, 'open_terminals', { count: 1, agent, prompts: [PELICAN], labels: [agent] });
    expect(r.isError, r.text).toBe(false);
    const o = r.json as Opened;
    expect(o.workspaceId).toBe(workspaceId);
    expect(o.lead).toBe(lead.terminalId);
    opened[agent] = o.terminals[0]!.terminalId;
  }

  // 2. 三个终端都起来，各自收到那条消息并回答 PELICAN
  for (const agent of ['pi', 'omp', 'kimi']) {
    const id = opened[agent]!;
    await expect
      .poll(() => fakeLog(deck, id).filter((e) => e.kind === 'first-message').map((e) => e['text']), { timeout: 45_000, message: `${agent} got its first message` })
      .toEqual([PELICAN]);
    await deck.waitForPane(id, /^\s*PELICAN\s*$/m);
  }
  // 后台：pi、omp 的消息在启动参数里（omp 在 `--` 之后）；kimi 的不在参数里，是终端安静后打进去的
  const start = (id: string) => fakeLog(deck, id).find((e) => e.kind === 'start') as { argv: string[] } | undefined;
  expect(start(opened['pi']!)?.argv).toContain(PELICAN);
  expect(start(opened['omp']!)?.argv.slice(-2)).toEqual(['--', PELICAN]);
  expect(start(opened['kimi']!)?.argv).not.toContain(PELICAN);
  // 都在 claude 的框里（同一个目录），白板上挂在 claude 旁边
  const b = await deck.board();
  for (const agent of ['pi', 'omp', 'kimi']) {
    const w = b.windows.find((x) => x.data['terminalId'] === opened[agent]);
    expect(w?.workspaceId, agent).toBe(workspaceId);
  }
  // pi、omp 的扩展真的加载了、经 agentdeck-notify 报了状态
  for (const agent of ['pi', 'omp']) expect(fakeLog(deck, opened[agent]!).some((e) => e.kind === 'extension-loaded'), agent).toBe(true);
  await deck.showAll();
  await deck.screenshot('three-agents');

  // 3. 再开一个 kimi、一个 pi、一个 omp，第一条消息以 @README.md 开头：原文送到（pi 前面多一个空格，不当成文件；omp 照原文）
  const at: Record<string, string> = {};
  for (const agent of ['kimi', 'pi', 'omp']) {
    const r = await mcpCall(sb, lead.terminalId, 'open_terminals', { count: 1, agent, prompts: [AT] });
    expect(r.isError, r.text).toBe(false);
    at[agent] = (r.json as Opened).terminals[0]!.terminalId;
  }
  for (const agent of ['kimi', 'pi', 'omp']) {
    const expected = agent === 'pi' ? ` ${AT}` : AT;
    await expect
      .poll(() => fakeLog(deck, at[agent]!).filter((e) => e.kind === 'first-message').map((e) => e['text']), { timeout: 45_000, message: `${agent} got the @ message` })
      .toEqual([expected]);
    await deck.waitForPane(at[agent]!, /^\s*HERON\s*$/m);
  }
  // kimi 没有丢字：一个字一个字打进去的，整句原样
  expect(fakeLog(deck, at['kimi']!).filter((e) => e.kind === 'message')).toEqual([]);
  expect(path).toBeTruthy();
  await deck.showAll();
  await deck.screenshot('at-messages');

  // 4. 给 shell 的 prompt：工具报错，一个终端都不开
  const before = (await deck.board()).windows.length;
  const shell = await mcpCall(sb, lead.terminalId, 'open_terminals', { count: 1, agent: 'shell', prompts: ['ls'] });
  expect(shell.isError).toBe(true);
  expect(shell.text).toMatch(/^Shell can't take a first message/);
  const single = await mcpCall(sb, lead.terminalId, 'open_terminal', { agent: 'shell', prompt: 'ls' });
  // open_terminal 的 prompt 对 shell 说明是 “Ignored for shells.”：同样不能悄悄丢掉
  expect(single.isError, single.text).toBe(true);
  expect(single.text).toMatch(/^Shell can't take a first message/);
  await page.waitForTimeout(1000);
  expect((await deck.board()).windows.length).toBe(before);
});
