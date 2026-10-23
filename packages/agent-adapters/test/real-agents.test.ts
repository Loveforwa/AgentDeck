// 用真的 claude / codex 跑一遍整条链：适配器算命令 → tmux 里启动 → 钩子 → agentdeck-notify → HookServer → 状态机。
// 默认跳过。手动跑：AGENTDECK_REAL_AGENTS=1 pnpm --filter @agentdeck/agent-adapters test real-agents
// 需要本机装了 tmux、claude、codex 并且已登录。提示词只让 agent 回答问题；唯一的权限请求会被拒绝（Esc），不改任何文件。
// 用单独的 tmux 实例（-L agentdeck-l4-real -f /dev/null），不碰用户自己的 tmux。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentKind, CreateTerminalRequest, StatusEvent, TerminalId, TerminalStatus } from '@agentdeck/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/runtime.ts';
import type { AgentRuntime } from '../src/runtime.ts';

const REAL = process.env.AGENTDECK_REAL_AGENTS === '1';
const NOTIFY = fileURLToPath(new URL('../../../tools/agentdeck-notify/bin/agentdeck-notify.mjs', import.meta.url));
/** 在已经信任过的目录里跑（这个仓库），免得 agent 弹“信任这个文件夹吗”。 */
const CWD = fileURLToPath(new URL('..', import.meta.url));
const SOCK = 'agentdeck-l4-real';

function tmux(...args: string[]): string {
  return execFileSync('tmux', ['-L', SOCK, '-f', '/dev/null', ...args], { encoding: 'utf8' });
}

let dir: string;
let socketPath: string;
let rt: AgentRuntime;
let events: StatusEvent[];
let n = 0;

async function waitFor(what: string, pred: () => boolean, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}\n${screen()}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

let current: TerminalId | null = null;
const screen = () => (current ? tmux('capture-pane', '-p', '-t', current) : '');
const status = (id: TerminalId): TerminalStatus | undefined => rt.status.get(id)?.status;
/** 文字和回车之间停一下：codex 会把紧跟在一段输入后面的回车当成粘贴里的换行。 */
const type = async (id: TerminalId, text: string) => {
  rt.noteInput(id);
  tmux('send-keys', '-t', id, '-l', text);
  await new Promise((r) => setTimeout(r, 500));
  tmux('send-keys', '-t', id, 'Enter');
};

/** 处理启动时可能出现的对话框（codex 的更新提示、信任文件夹），等到输入框出现。这是测试脚手架，产品里不识别屏幕文字。 */
async function waitForCodexPrompt(id: TerminalId): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const s = screen();
    if (/Skip until next version/.test(s)) {
      tmux('send-keys', '-t', id, '2');
      tmux('send-keys', '-t', id, 'Enter');
    } else if (/Trust this folder/i.test(s)) tmux('send-keys', '-t', id, 'Enter');
    else if (/Ask Codex to do anything|for shortcuts/.test(s)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`codex prompt did not appear\n${screen()}`);
}

describe.skipIf(!REAL)('real agents in tmux', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adr-'));
    socketPath = join(dir, 'hooks.sock');
    events = [];
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    rt = createAgentRuntime({
      env: () => env,
      notifyCommand: NOTIFY,
      socketPath,
      emit: (e) => events.push(e),
      destructivePatterns: () => ['\\bmkdir\\b'],
      // 用户默认可能是 auto 模式，那样不会弹权限确认；这里固定成会问的模式。
      extraArgs: (agent: AgentKind) =>
        agent === 'claude' ? ['--permission-mode', 'default'] : agent === 'codex' ? ['-a', 'on-request', '-s', 'read-only'] : [],
      terminals: {
        // 最小的 tmux 版 create：AGENTDECK_TERM 和 socket 路径写进会话环境。
        create: async (req: CreateTerminalRequest) => {
          const id = `l4real-${++n}` as TerminalId;
          const envArgs = Object.entries({ ...req.env, AGENTDECK_TERM: id, AGENTDECK_HOOK_SOCKET: socketPath }).flatMap(([k, v]) => [
            '-e',
            `${k}=${v}`,
          ]);
          tmux('new-session', '-d', '-s', id, '-x', '160', '-y', '45', '-c', req.cwd, ...envArgs, req.cmd, ...req.args);
          return { id };
        },
      },
    });
    await rt.start();
  });

  afterAll(async () => {
    try {
      tmux('kill-server');
    } catch {
      // 已经没了
    }
    await rt?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('claude: idle → running → idle with the session id we passed', async () => {
    const res = await rt.agents.start({ agent: 'claude', cwd: CWD, workspaceId: null, mode: { kind: 'new' } });
    const id = (current = res.terminalId);
    expect(res.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor('claude SessionStart', () => status(id) === 'idle', 30_000);
    expect(rt.status.get(id)!.sessionId).toBe(res.sessionId);

    await type(id, 'Reply with exactly OK and nothing else.');
    await waitFor('running', () => status(id) === 'running' || events.some((e) => e.type === 'agent.turn-end'));
    await waitFor('turn end', () => events.some((e) => e.type === 'agent.turn-end' && e.terminalId === id));
    expect(status(id)).toBe('idle');
  }, 120_000);

  it('claude: AskUserQuestion → needs-reply; answering → idle', async () => {
    const id = current!;
    await type(id, 'Use the AskUserQuestion tool to ask me whether I prefer tea or coffee. Do nothing else.');
    await waitFor('needs-reply', () => status(id) === 'needs-reply');
    expect(rt.status.get(id)!.pending).toMatchObject({ kind: 'question', summary: expect.stringMatching(/tea or coffee/i) });
    rt.noteInput(id);
    tmux('send-keys', '-t', id, 'Enter'); // 选第一项
    await waitFor('idle after answer', () => status(id) === 'idle');
  }, 120_000);

  it('claude: permission request → needs-approval with the command; denied with Esc', async () => {
    const id = current!;
    const target = join(dir, 'should-not-exist');
    await type(id, `Run the shell command \`mkdir ${target}\` with the Bash tool. Do nothing else.`);
    await waitFor('needs-approval', () => status(id) === 'needs-approval');
    const pending = rt.status.get(id)!.pending!;
    expect(pending).toMatchObject({ kind: 'approval', command: `mkdir ${target}`, destructive: true });
    rt.noteInput(id);
    tmux('send-keys', '-t', id, 'Escape');
    // claude 拒绝时没有钩子：这里没有 tmux 的 silence 事件，手动补一个，走第 15 行的兜底。
    await new Promise((r) => setTimeout(r, 3000));
    rt.onTerminalEvent({ type: 'terminal.silence', id, at: new Date().toISOString() });
    expect(status(id)).toBe('idle');
    expect(existsSync(target)).toBe(false);
    tmux('kill-session', '-t', id);
  }, 120_000);

  it('codex: hooks are trusted via -c; permission request; Esc → Interrupt → idle', async () => {
    const info = (await rt.agents.list()).find((a) => a.id === 'codex')!;
    expect(info.capabilities.hooks).toBe(true);
    const res = await rt.agents.start({ agent: 'codex', cwd: CWD, workspaceId: null, mode: { kind: 'new' } });
    const id = (current = res.terminalId);
    expect(res.args.some((a) => a.startsWith('hooks.state='))).toBe(true);
    await waitForCodexPrompt(id);
    // codex 的 SessionStart 要等第一次输入才触发（实测），所以先发问题再看会话 id。
    const target = join(dir, 'codex-should-not-exist');
    await type(id, `Run the shell command \`mkdir ${target}\` (it needs approval because the sandbox is read-only). Do nothing else.`);
    await waitFor('needs-approval', () => status(id) === 'needs-approval', 120_000);
    expect(rt.status.get(id)!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rt.status.get(id)!.pending).toMatchObject({ kind: 'approval', command: `mkdir ${target}`, destructive: true });
    tmux('send-keys', '-t', id, 'Escape');
    await waitFor('idle after Interrupt', () => status(id) === 'idle');
    expect(existsSync(target)).toBe(false);
    tmux('kill-session', '-t', id);
  }, 240_000);
});
