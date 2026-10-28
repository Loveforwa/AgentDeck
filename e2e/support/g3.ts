// g3 验收用例（agent、MCP、状态、插件）共用的小工具：把假 codex / pi / omp / kimi / 数据库 TUI 装进沙盒的 PATH，
// 用某个终端的身份调 AgentDeck 的 MCP（和 agent 自己调一样：Bearer 是这个终端的钥匙，请求头带终端 id），读批准记录、额度列表。
import { createHmac } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { Deck } from './deck.ts';
import { E2E_DIR, type Sandbox } from './sandbox.ts';

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * 在沙盒的 fakebin（PATH 最前面）里放一个假程序：`name` 运行 `node <fake-agent/script> [前置参数] "$@"`。
 * 要在 deck.launch() 之前装好（AgentDeck 启动时检测装了哪些 agent）；重写同一个名字等于“升级”（文件修改时间变了）。
 */
export function installFake(sb: Sandbox, name: string, script: string, lead: string[] = []): string {
  const file = join(sb.root, 'fakebin', name);
  const args = [process.execPath, join(E2E_DIR, 'fake-agent', script), ...lead].map(q).join(' ');
  writeFileSync(file, `#!/bin/sh\nexec ${args} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

export const installCodex = (sb: Sandbox) => installFake(sb, 'codex', 'fake-codex.mjs');
export const installPi = (sb: Sandbox, version = '0.83.0') => installFake(sb, 'pi', 'fake-pi.mjs', ['--fake-as', 'pi', '--fake-version', version, '--']);
export const installOmp = (sb: Sandbox, version = '18.0.4') => installFake(sb, 'omp', 'fake-pi.mjs', ['--fake-as', 'omp', '--fake-version', version, '--']);
export const installKimi = (sb: Sandbox) => installFake(sb, 'kimi', 'fake-kimi.mjs');
/** 假的数据库 TUI（harlequin、lazysql、pgcli…）：fake-tui.mjs <名字>。 */
export const installTui = (sb: Sandbox, name: string) => installFake(sb, name, 'fake-tui.mjs', [name]);

/** 假程序的日志（fake-common.mjs 的 logger 写的），按文件名前缀和终端 id 找。 */
export function fakeLog(deck: Deck, terminalId: string): { kind: string; [k: string]: unknown }[] {
  return deck.agentLog(terminalId) as unknown as { kind: string; [k: string]: unknown }[];
}

export interface McpResult {
  isError: boolean;
  text: string;
  /** text 是 JSON 时解析出来的值。 */
  json: unknown;
}

/**
 * 以终端 caller 的身份调 AgentDeck 的 MCP 工具（agent 发的就是这样的请求：POST /mcp，Bearer 终端钥匙 = HMAC(mcp-token, 终端 id)，
 * x-agentdeck-terminal: 终端 id）。地址读 <数据目录>/run/api.json（47621 被别的实例占着时 AgentDeck 换随机端口）。
 */
export async function mcpCall(sb: Sandbox, caller: string, tool: string, args: Record<string, unknown> = {}): Promise<McpResult> {
  const run = join(sb.dataDir, 'run');
  const token = readFileSync(join(run, 'mcp-token'), 'utf8').trim();
  const { url } = JSON.parse(readFileSync(join(run, 'api.json'), 'utf8')) as { url: string };
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${createHmac('sha256', token).update(caller).digest('hex')}`,
      'x-agentdeck-terminal': caller,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`MCP ${tool}: HTTP ${res.status} ${raw}`);
  // enableJsonResponse：一整个 JSON；保险起见也认 SSE 的 data: 行
  const body = (raw.trimStart().startsWith('{') ? JSON.parse(raw) : JSON.parse(raw.split('\n').find((l) => l.startsWith('data: '))!.slice(6))) as {
    result?: { isError?: boolean; content?: { type: string; text: string }[] };
    error?: { message: string };
  };
  if (body.error) throw new Error(`MCP ${tool}: ${body.error.message}`);
  const text = body.result?.content?.map((c) => c.text).join('') ?? '';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: body.result?.isError === true, text, json };
}

/** 按键直接经 tmux 送进终端（像 agent 在别处打字，焦点不动）。 */
export function sendLine(sb: Sandbox, terminalId: string, text: string): void {
  sb.tmux(['send-keys', '-t', `=${terminalId}:`, '-l', text]);
  sb.tmux(['send-keys', '-t', `=${terminalId}:`, 'Enter']);
}

type Limits = {
  key: string;
  agent: string;
  resetsAt: string | null;
  terminals: { terminalId: string; state: string; owner: string; resumeAt?: string | null; message?: string | null }[];
}[];

export const limitsList = (deck: Deck) =>
  deck.page.evaluate(() => (window as unknown as { agentdeck: { limits: { list(): Promise<Limits> } } }).agentdeck.limits.list());

/** 批准记录（ApprovalService.history）。 */
export const approvalHistory = (deck: Deck, workspaceId: string) =>
  deck.page.evaluate(
    (ws) =>
      (
        window as unknown as {
          agentdeck: { approvals: { history(ws: string, n: number): Promise<{ by: string; at: string; request: { terminalId: string; summary: string; command: string | null } }[]> } };
        }
      ).agentdeck.approvals.history(ws, 50),
    workspaceId,
  );

/** 右键窗口标题栏（偏左，避开标题栏右边的按钮）。 */
export async function rightClickTitlebar(deck: Deck, windowId: string): Promise<void> {
  // 没聚焦的窗口按下时先聚焦、重排，右键会落到白板上（e2e/AGENTS.md「已知问题」里单击的同一个问题）：先聚焦
  // （不是被测的步骤，走白板控制器），等窗口停稳
  await deck.page.evaluate((id) => (window as unknown as { __board: { focusWindow(id: string): void } }).__board.focusWindow(id), windowId);
  await expect.poll(async () => (await deck.board()).focusedId).toBe(windowId);
  let last = '';
  await expect
    .poll(async () => {
      const now = JSON.stringify(await deck.windowEl(windowId).locator('.ad-window-titlebar').boundingBox());
      const same = now === last;
      last = now;
      return same;
    }, { intervals: [200] })
    .toBe(true);
  // 白板缩小时标题栏只有十几像素高：按它在屏幕上的实际位置点（偏左、竖直居中），避开标题栏右边的按钮
  const box = await deck.windowEl(windowId).locator('.ad-window-titlebar').boundingBox();
  if (!box) throw new Error(`titlebar of ${windowId} not visible`);
  await deck.page.mouse.click(box.x + Math.min(60, box.width / 4), box.y + box.height / 2, { button: 'right' });
  await expect(deck.page.getByRole('menu').first()).toBeVisible();
}

/** 改 settings.json（deck.launch() 之前）。 */
export function patchSettings(sb: Sandbox, patch: Record<string, unknown>): void {
  const file = join(sb.dataDir, 'settings.json');
  const cur = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...cur, ...patch }, null, 2)}\n`);
}
