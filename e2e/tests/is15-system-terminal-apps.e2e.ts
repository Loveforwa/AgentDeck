// IS-15：Open in system terminal。默认的 Terminal.app（osascript do script）由 tc11-system-terminal 覆盖（截下命令、在伪终端里跑、两边同步）。
// 这里补 Settings 里的 Terminal app 另外两种走法（app-service.ts systemTerminalPlan）：
// - iTerm：osascript `create window with default profile command "…"`；
// - 别的 App（Ghostty 之类）：写 <数据目录>/run/attach-<id>.command（可执行、exec 那条命令），交给 `/usr/bin/open -a <App> <文件>`。
// 两种都不真开 App：主进程里包一层 child_process.spawn（同 support/system-terminal.ts 的做法，这里另写一份，能让它“失败”），
// 截下的命令 / .command 文件在 node-pty 伪终端里跑，断言接上的是沙盒 socket 上同一个 tmux 会话（两个客户端，系统终端那边打的字进了 claude）。
// 只能人工：Terminal.app / iTerm / Ghostty 真的弹出来；第一次用时 macOS 的“自动化”权限对话框。
import type * as ChildProcess from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type * as NodeModule from 'node:module';
import type { Deck } from '../support/deck.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, setupWorktree } from '../support/flows.ts';
import { patchSettings } from '../support/g3.ts';
import { makeRepo } from '../support/repo.ts';
import { attachInPty, commandFromAppleScript, type PtySession } from '../support/system-terminal.ts';

interface Spawned {
  cmd: string;
  args: string[];
}

/** 截下 osascript / open：记参数，改跑一个 sh（fail 为 true 时像 macOS 拒绝那样往 stderr 写一句、退出码 1）。 */
async function capture(deck: Deck, fail = false): Promise<void> {
  await deck.app.evaluate((_e, fail) => {
    const g = globalThis as unknown as { __h4Spawns?: { cmd: string; args: string[] }[] };
    if (g.__h4Spawns) return;
    g.__h4Spawns = [];
    const cp = process.getBuiltinModule('node:child_process') as typeof ChildProcess;
    const original = cp.spawn;
    cp.spawn = ((cmd: string, args?: readonly string[], opts?: object) => {
      if (cmd === '/usr/bin/osascript' || cmd === '/usr/bin/open') {
        g.__h4Spawns!.push({ cmd, args: [...(args ?? [])] });
        const script = fail ? 'echo "Unable to find application named \\"NoSuchTerm\\"" >&2; exit 1' : 'exit 0';
        return original('/bin/sh', ['-c', script], { ...(opts ?? {}), stdio: 'ignore' });
      }
      return (original as (...a: unknown[]) => unknown)(cmd, args, opts);
    }) as typeof cp.spawn;
    (process.getBuiltinModule('node:module') as typeof NodeModule).syncBuiltinESMExports();
  }, fail);
}
const spawned = (deck: Deck) => deck.app.evaluate(() => (globalThis as unknown as { __h4Spawns?: Spawned[] }).__h4Spawns ?? []);

async function setup(deck: Deck, branch: string) {
  const repo = makeRepo(deck.sb, 'shop');
  await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, branch);
  const claude = await openFakeClaude(deck, workspaceId);
  await deck.showAll();
  return claude;
}

async function openInSystemTerminal(deck: Deck, windowId: string): Promise<Spawned> {
  await deck.windowEl(windowId).locator('.ad-window-titlebar').click({ button: 'right', position: { x: 80, y: 10 } });
  await deck.pickMenu(['Open in system terminal']);
  let s: Spawned[] = [];
  await expect.poll(async () => (s = await spawned(deck)).length).toBe(1);
  return s[0]!;
}

/** 在伪终端里跑 command，等它接上同一个会话，再从那边打一行，看进了 claude。 */
async function attachAndType(deck: Deck, terminalId: string, command: string, line: string): Promise<void> {
  const sb = deck.sb;
  let sys: PtySession | null = attachInPty(sb, command);
  try {
    const clients = () => sb.tmux(['list-clients', '-t', `=${terminalId}`, '-F', '#{client_tty}']).stdout.trim().split('\n').filter(Boolean);
    await expect.poll(() => clients().length, { timeout: 15_000 }).toBe(2);
    const session = /session: (\S+)/.exec(deck.pane(terminalId))?.[1];
    expect(session).toBeTruthy();
    await expect.poll(() => sys!.text(), { timeout: 15_000 }).toContain(`session: ${session}`);
    sys.write(`${line}\r`);
    await expect.poll(() => deck.agentLog(terminalId).some((e) => e.kind === 'input' && e.line === line)).toBe(true);
    await deck.screenshot('attached');
    sys.close();
    sys = null;
    await expect.poll(() => clients().length, { timeout: 15_000 }).toBe(1);
    expect(sb.tmux(['has-session', '-t', `=${terminalId}`]).status).toBe(0);
  } finally {
    sys?.close();
  }
}

const attachRe = (socket: string, id: string) => new RegExp(`/tmux'? '?-L'? '?${socket}'? .*'?attach-session'? '?-t'? '?=${id}'?$`);

test('IS-15 Terminal app set to iTerm in Settings: AppleScript opens an iTerm window running tmux attach on the AgentDeck socket', async ({ deck, sb }) => {
  const claude = await setup(deck, 'feat/iterm');
  const page = deck.page;
  await capture(deck);
  // Settings › General › Terminal app = iTerm（真的输入、Save）
  await page.locator('.ad-topbar').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: /Settings/ });
  await dialog.getByRole('button', { name: 'General' }).click();
  await dialog.getByRole('textbox', { name: 'Terminal app' }).fill('iTerm');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => JSON.parse(readFileSync(join(sb.dataDir, 'settings.json'), 'utf8')).terminalApp as string).toBe('iTerm');

  const s = await openInSystemTerminal(deck, claude.windowId);
  expect(s.cmd).toBe('/usr/bin/osascript');
  const script = s.args[s.args.indexOf('-e') + 1]!;
  expect(script).toMatch(/^tell application "iTerm"\nactivate\ncreate window with default profile command "/);
  const command = commandFromAppleScript(script);
  expect(command).toMatch(attachRe(sb.tmuxSocket, claude.terminalId));
  await attachAndType(deck, claude.terminalId, command!, 'done from-iterm');
});

test('IS-15 another terminal app (Ghostty): a .command file running tmux attach is opened with open -a', async ({ deck, sb }) => {
  patchSettings(sb, { terminalApp: 'Ghostty' });
  const claude = await setup(deck, 'feat/ghostty');
  await capture(deck);
  const s = await openInSystemTerminal(deck, claude.windowId);
  expect(s.cmd).toBe('/usr/bin/open');
  expect(s.args.slice(0, 2)).toEqual(['-a', 'Ghostty']);
  const file = s.args[2]!;
  // 放在应用的 run 目录（数据目录对应的 /tmp/agentdeck-<uid>-<hash>/，和钩子 socket 同一处）
  expect(file).toMatch(new RegExp(`/attach-${claude.terminalId}\\.command$`));
  try {
    expect(statSync(file).mode & 0o111).not.toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('#!/bin/sh\nexec ')).toBe(true);
    expect(text.trim().slice('#!/bin/sh\nexec '.length)).toMatch(attachRe(sb.tmuxSocket, claude.terminalId));
    // 系统终端会直接执行这个文件
    await attachAndType(deck, claude.terminalId, `'${file}'`, 'done from-ghostty');
  } finally {
    rmSync(file, { force: true });
  }
});

// 已知缺口（新问题，见报告）：osascript / open 失败（没装这个 App、macOS 不给“自动化”权限）时什么也不提示——
// run() 只等进程起来、不看退出码，界面也 catch 掉了错误。修好后这条会“意外通过”，那时去掉 test.fail。
test.fail('IS-15 when the terminal app can’t be opened, the board says so', async ({ deck, sb }) => {
  patchSettings(sb, { terminalApp: 'NoSuchTerm' });
  const claude = await setup(deck, 'feat/noterm');
  await capture(deck, true);
  const s = await openInSystemTerminal(deck, claude.windowId);
  expect(s.args.slice(0, 2)).toEqual(['-a', 'NoSuchTerm']);
  await expect(deck.page.getByText(/NoSuchTerm/).first()).toBeVisible({ timeout: 8000 });
});
