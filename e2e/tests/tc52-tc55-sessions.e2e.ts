// TC-52（SE2）：claude 里 /clear 以后，前一段对话仍算这个窗口的 Session——后台部分。
// TC-55（SE1）：老白板上的窗口组（open_terminals 的 Lead + 3 个子终端）升级后变成父子 Session——后台部分。
//
// 界面部分（左边栏一行、悬停卡片 “2 conversations · cleared …”、Earlier conversation 的 Resume / Fork、子终端标题栏的
// “↳ claude · lead”）等 SE4、SE5，还没做，这里不测。
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, openTerminal, setupWorktree } from '../support/flows.ts';
import { shieldRealAgents } from '../support/g4-env.ts';
import { makeRepo } from '../support/repo.ts';
import { REPO_ROOT } from '../support/sandbox.ts';

interface SessionRow {
  id: string;
  agent: string;
  parentId: string | null;
  origin: { kind: string; tool?: string };
  label: string | null;
  terminalId: string | null;
  state: string;
  agentSessions: { id: string; reason: string }[];
}

async function sessions(deck: Deck): Promise<SessionRow[]> {
  return deck.page.evaluate(async () => {
    const w = window as unknown as { agentdeck: { sessions: { list(o?: object): Promise<unknown[]> } } };
    return JSON.parse(JSON.stringify(await w.agentdeck.sessions.list())) as never;
  });
}

/** 关窗口（标题栏的 ×），要确认停进程时点 Stop and close。 */
async function closeWindow(deck: Deck, windowId: string) {
  const win = deck.windowEl(windowId);
  await deck.focusWindow(windowId);
  await win.getByRole('button', { name: /^Close/ }).first().click({ delay: 80 });
  const stop = deck.page.getByRole('button', { name: /^Stop and close/ });
  if (await stop.isVisible({ timeout: 3_000 }).catch(() => false)) await stop.click();
  await expect.poll(async () => (await deck.board()).windows.some((w) => w.id === windowId)).toBe(false);
}

test('TC-52 /clear in claude keeps the same Session with a second conversation (backend)', async ({ deck, sb }) => {
  shieldRealAgents(sb);
  const repo = makeRepo(sb, 'api');
  await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/clear');
  // 前提：框里一个 claude，已经聊过两轮
  const t = await openFakeClaude(deck, workspaceId);
  await deck.showAll();
  await deck.focusWindow(t.windowId);
  for (const reply of ['one', 'two']) {
    await deck.typeLine('work');
    await deck.waitForStatus(t.terminalId, 'running');
    await deck.typeLine(`done ${reply}`);
    await deck.waitForPane(t.terminalId, new RegExp(`● ${reply}`));
  }
  const first = (await deck.board()).windows.find((w) => w.id === t.windowId)!.data['sessionId'] as string;
  let mine: SessionRow | undefined;
  await expect
    .poll(async () => {
      mine = (await sessions(deck)).find((s) => s.terminalId === t.terminalId);
      return mine?.agentSessions.map((a) => a.id);
    })
    .toEqual([first]);
  const sessionId = mine!.id;
  const dataSessionBefore = (await deck.board()).windows.find((w) => w.id === t.windowId)!.data['session'] ?? null;

  // 1. 在 claude 里 /clear（假 claude 的 clear：SessionStart source clear、新的会话 id），再聊一轮
  await deck.typeLine('clear');
  const cleared = await deck.waitForPane(t.terminalId, /Cleared\. session: ([0-9a-f-]{36})/);
  const second = /Cleared\. session: ([0-9a-f-]{36})/.exec(cleared)![1]!;
  expect(second).not.toBe(first);
  await deck.typeLine('work');
  await deck.waitForStatus(t.terminalId, 'running');
  await deck.typeLine('done three');
  await deck.waitForPane(t.terminalId, /● three/);

  // 后台：还是同一条 Session，agent 会话 id 有两段，第二段原因是 clear（从 SessionStart 钩子的 source 读出）
  await expect
    .poll(async () => (await sessions(deck)).find((s) => s.id === sessionId)?.agentSessions.map((a) => `${a.id}:${a.reason}`))
    .toEqual([`${first}:start`, `${second}:clear`]);
  const all = await sessions(deck);
  expect(all.filter((s) => s.agent === 'claude')).toHaveLength(1);
  expect(all.find((s) => s.id === sessionId)).toMatchObject({ terminalId: t.terminalId, state: 'running', workspaceId });
  // 窗口的 data.session 没变
  expect((await deck.board()).windows.find((w) => w.id === t.windowId)!.data['session'] ?? null).toEqual(dataSessionBefore);
  await deck.screenshot('after-clear');

  // 3. 关掉窗口：Session 留下（stopped），两段对话都还在
  await closeWindow(deck, t.windowId);
  await expect.poll(async () => (await sessions(deck)).find((s) => s.id === sessionId)?.state).toBe('stopped');
  const after = (await sessions(deck)).find((s) => s.id === sessionId)!;
  expect(after.terminalId).toBeNull();
  expect(after.agentSessions.map((a) => a.id)).toEqual([first, second]);
});

// ---- TC-55 ----

/** 迁移 1（initial）的 SQL：从 packages/store/src/migrations.ts 原文里取（e2e 不能 import 服务包，按文本读）。 */
function initialSchemaSql(): string {
  const src = readFileSync(join(REPO_ROOT, 'packages/store/src/migrations.ts'), 'utf8');
  const start = src.indexOf("name: 'initial'");
  const open = src.indexOf('db.exec(`', start) + 'db.exec(`'.length;
  const close = src.indexOf('`);', open);
  if (start < 0 || close < 0) throw new Error('could not find the initial migration');
  return src.slice(open, close);
}

type Row = Record<string, unknown>;

/** BoardSnapshot 里没列 group，按原样读。 */
const groupOf = (w: object) => (w as { group?: unknown }).group ?? null;

/**
 * 把新版本建的库换成“旧版本（schema 1，还没有 sessions 表）”写的库：表结构是迁移 1 的，数据从新库搬过来，
 * 白板 JSON 里去掉 data.session、给窗口加上 open_terminals 存的 group（旧版本就是这样存的）。另加一条 tmux 里没有的终端记录。
 */
function downgradeToSchema1(dbPath: string, groups: Record<string, { role: 'lead' | 'member'; label: string | null }>, groupId: string) {
  const cur = new DatabaseSync(dbPath, { readOnly: true });
  const board = cur.prepare('SELECT state, saved_at FROM board WHERE id = 1').get() as { state: string; saved_at: string };
  const projects = cur.prepare('SELECT * FROM projects').all() as Row[];
  const workspaces = cur.prepare('SELECT * FROM workspaces').all() as Row[];
  const terminals = cur.prepare('SELECT * FROM terminals').all() as Row[];
  cur.close();

  const state = JSON.parse(board.state) as { version: number; windows: { id: string; type: string; group?: unknown; data: Row }[] };
  expect(state.version).toBe(1);
  for (const w of state.windows) {
    if (w.type !== 'terminal') continue;
    delete w.data['session'];
    const g = groups[w.id];
    if (g) w.group = { id: groupId, role: g.role, label: g.label, ...(g.role === 'lead' ? { view: { mode: 'all' } } : {}) };
  }

  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec(initialSchemaSql());
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (1, ?, ?)').run('initial', new Date().toISOString());
  const copy = (table: string, rows: Row[], rename: Record<string, string | null> = {}) => {
    for (const r of rows) {
      const entries = Object.entries(r).flatMap(([k, v]) => (k in rename ? (rename[k] ? [[rename[k]!, v] as const] : []) : [[k, v] as const]));
      const sql = `INSERT INTO ${table} (${entries.map(([k]) => k).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`;
      db.prepare(sql).run(...(entries.map(([, v]) => v) as never[]));
    }
  };
  copy('projects', projects);
  copy('workspaces', workspaces);
  // schema 1 的 terminals.session_id 存的是 agent 的会话 id（迁移 2 改名成 agent_session_id）
  copy('terminals', terminals, { session_id: null, agent_session_id: 'session_id' });
  const t0 = terminals[0]!;
  db.prepare(
    'INSERT INTO terminals (terminal_id, window_id, workspace_id, agent, cmd, args, cwd, session_id, start_command, last_status, exit_code, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)',
  ).run('t-stale0000000', t0['workspace_id'] as string, 'shell', 'bash', '[]', t0['cwd'] as string, 'idle', new Date().toISOString());
  db.prepare('INSERT INTO board (id, state, saved_at) VALUES (1, ?, ?)').run(JSON.stringify(state), board.saved_at);
  db.close();
}

function readDb<T>(dbPath: string, sql: string): T[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

test('TC-55 an old board with an open_terminals window group becomes parent / child Sessions after upgrading (backend)', async ({ deck, sb }) => {
  shieldRealAgents(sb);
  const repo = makeRepo(sb, 'api');
  await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/group');
  // 前提：旧版本开过一个窗口组（Lead 是 claude + 3 个子终端），然后退出
  const lead = await openFakeClaude(deck, workspaceId);
  const members: { windowId: string; terminalId: string }[] = [];
  for (let i = 0; i < 3; i++) members.push(await openTerminal(deck, workspaceId, 'shell'));
  const labels = ['api', 'web', 'db'];
  await deck.quit();
  const dbPath = join(sb.dataDir, 'agentdeck.db');
  const groups: Record<string, { role: 'lead' | 'member'; label: string | null }> = { [lead.windowId]: { role: 'lead', label: null } };
  members.forEach((m, i) => (groups[m.windowId] = { role: 'member', label: labels[i]! }));
  downgradeToSchema1(dbPath, groups, 'grp-e2e-1');
  expect(readDb<{ v: number }>(dbPath, 'SELECT MAX(version) AS v FROM schema_version')[0]!.v).toBe(1);

  // 1. “装新版本”，打开应用
  await deck.launch();
  const b = await deck.board();

  // 后台：迁移给白板上每个终端窗口建了一条 Session，写回 data.session
  const all = await sessions(deck);
  const byWindow = new Map<string, SessionRow>();
  for (const t of [lead, ...members]) {
    const w = b.windows.find((x) => x.id === t.windowId)!;
    const id = w.data['session'];
    expect(typeof id, `window ${t.windowId} has data.session`).toBe('string');
    const s = all.find((x) => x.id === id);
    expect(s, `session for ${t.windowId}`).toBeDefined();
    byWindow.set(t.windowId, s!);
  }
  const leadSession = byWindow.get(lead.windowId)!;
  // 老的 WindowNode.group 转成 parentId：子终端的父是 Lead 那条，来历 spawn · open_terminals，名字是 label
  expect(leadSession).toMatchObject({ agent: 'claude', parentId: null, origin: { kind: 'user' }, terminalId: lead.terminalId, state: 'running' });
  expect(leadSession.agentSessions.map((a) => a.reason)).toEqual(['unknown']);
  members.forEach((m, i) => {
    expect(byWindow.get(m.windowId)).toMatchObject({
      agent: 'shell',
      parentId: leadSession.id,
      origin: { kind: 'spawn', tool: 'open_terminals' },
      label: labels[i],
      terminalId: m.terminalId,
      state: 'running',
    });
  });
  const children = await deck.page.evaluate(
    async (id) => (window as unknown as { agentdeck: { sessions: { children(id: string): Promise<{ id: string }[]> } } }).agentdeck.sessions.children(id),
    leadSession.id,
  );
  expect(children.map((c) => c.id).sort()).toEqual(members.map((m) => byWindow.get(m.windowId)!.id).sort());
  // UI（2. 侧边栏照旧）：group 还留在白板上，终端都接回了
  for (const t of [lead, ...members]) {
    expect(groupOf(b.windows.find((x) => x.id === t.windowId)!)).toBeTruthy();
    await expect(deck.windowEl(t.windowId).locator('.ad-terminal__notice')).toHaveCount(0);
  }
  await deck.screenshot('migrated');

  // 后台：terminals 表里已经没有进程的旧记录清掉了；schema 升到最新
  await expect
    .poll(() => readDb<{ terminal_id: string }>(dbPath, 'SELECT terminal_id FROM terminals').map((r) => r.terminal_id))
    .not.toContain('t-stale0000000');
  expect(readDb<{ v: number }>(dbPath, 'SELECT MAX(version) AS v FROM schema_version')[0]!.v).toBeGreaterThan(1);

  // 3. 关掉 Lead：子终端平铺开（去掉 group，和现在一样），但父子关系（标签）还在 Session 上
  await closeWindow(deck, lead.windowId);
  await expect.poll(async () => (await deck.board()).windows.filter((w) => members.some((m) => m.windowId === w.id) && groupOf(w)).length).toBe(0);
  const later = await sessions(deck);
  for (const [i, m] of members.entries()) {
    expect(later.find((s) => s.id === byWindow.get(m.windowId)!.id)).toMatchObject({ parentId: leadSession.id, label: labels[i], state: 'running' });
  }
  await expect.poll(async () => (await sessions(deck)).find((s) => s.id === leadSession.id)?.state).toBe('stopped');
  await deck.screenshot('lead-closed');
});
