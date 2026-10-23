// 核对 Approve all 的“允许一次”按键（调研记录 F2）：在 tmux 里起真的 claude / codex，让它跑一条无副作用的命令，
// 等它弹出批准提示，用 sendKeys 发适配器里写的按键（claude ['Enter']、codex ['y']），看命令是不是只被允许了这一次。
//
//   node packages/tmux-host/scripts/approve-keys.ts claude
//   node packages/tmux-host/scripts/approve-keys.ts codex
//
// 会真的调用模型（一两轮）。claude 在仓库目录里跑（已信任的目录，免得改用户的信任列表）；
// codex 用临时 CODEX_HOME（复制 auth.json、config.toml 并信任临时目录），结束后清掉它留下的守护进程（F7 问题 15）。
// 用 tmux -L agentdeck-keys，结束时 kill-server。环境取登录 shell 的（docs/decisions.md）：本机靠它里面的代理变量才连得上。

import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TerminalId } from '@agentdeck/contracts';
import { startTmuxHost } from '../src/index.ts';

const agent = process.argv[2] ?? 'claude';
/** 第三个参数可以换成别的按键试，例如 `claude 1`、`codex Enter`（逗号分隔）。 */
const keys = process.argv[3]?.split(',') ?? (agent === 'claude' ? ['Enter'] : ['y']);
const SOCKET = 'agentdeck-keys';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loginEnv(): Promise<Record<string, string>> {
  const shell = process.env.SHELL ?? '/bin/zsh';
  const base: Record<string, string> = {};
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'PATH']) if (process.env[k]) base[k] = process.env[k]!;
  return new Promise((ok) =>
    execFile(shell, ['-ilc', 'env -0'], { env: base, timeout: 5000, maxBuffer: 4 << 20 }, (_e, out) => {
      const env: Record<string, string> = {};
      for (const kv of (out ?? '').split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      ok(Object.keys(env).length > 0 ? env : base);
    }),
  );
}

const env = await loginEnv();
const host = await startTmuxHost({ env, socketName: SOCKET, onEvent: () => {}, onData: () => {} });
const id = `keys-${agent}` as TerminalId;
const screen = async () => (await host.lastLines(id, 60)).join('\n');

async function waitScreen(pred: (s: string) => boolean, label: string, timeoutMs = 120_000): Promise<string> {
  const t0 = Date.now();
  let s = '';
  while (Date.now() - t0 < timeoutMs) {
    s = await screen();
    if (pred(s)) return s;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}; screen:\n${s}`);
}

let codexHome: string | null = null;
let cwd: string;
const result: Record<string, string> = { agent };

try {
  if (agent === 'claude') {
    cwd = resolve(import.meta.dirname, '../../..');
    // 用户可能默认开着 auto 模式（本机就是），那样不会弹批准提示；这里固定用 default
    await host.create({ id, cmd: 'claude', args: ['--permission-mode', 'default'], cwd, env: { CLAUDE_CODE_TMUX_TRUECOLOR: '1' }, size: { cols: 120, rows: 40 } });
    let s = await waitScreen((x) => /trust|for shortcuts|❯|\? for/i.test(x), 'claude prompt', 60_000);
    if (/Do you trust/i.test(s)) {
      result.trustDialog = 'shown, answered with Enter';
      await host.sendKeys(id, ['Enter']);
      s = await waitScreen((x) => /for shortcuts|❯|\? for/i.test(x), 'claude input box', 60_000);
    }
    await sleep(1000);
    // echo、printf 这类只读命令 claude 会直接放行，用 node -e 打印一行（同样没有副作用）才会问
    await host.sendKeys(id, [`Use the Bash tool to run exactly this command: node -e "console.log('ok-from-agentdeck')". Do nothing else.`]);
    await sleep(300);
    await host.sendKeys(id, ['Enter']);
    s = await waitScreen((x) => /Do you want to proceed|Yes, and don|❯ 1\. Yes/i.test(x) || /⎿\s+ok-from-agentdeck/.test(x), 'permission prompt');
    result.prompt = s.split('\n').filter((l) => /proceed|Yes|No|❯|node -e/.test(l)).join(' | ');
    if (!/Do you want to proceed|❯ 1\. Yes/.test(s)) throw new Error('claude ran the command without asking (an allow rule matched?)');
    result.highlighted = /❯\s*1\.\s*Yes/.test(s) ? '1. Yes (default)' : 'unknown';
    result.keys = keys.join(',');
    await host.sendKeys(id, keys); // ClaudeAdapter.approveOnceKeys = ['Enter']
    s = await waitScreen((x) => !/Do you want to proceed/.test(x) && /⎿\s+ok-from-agentdeck/.test(x), 'command result', 90_000);
    result.afterEnter = /Do you want to proceed/.test(s) ? 'still asking' : 'prompt closed, command ran';
    // “允许一次”不应写进 .claude/settings.local.json
    const local = join(cwd, '.claude', 'settings.local.json');
    result.persistedRule = existsSync(local) && /node -e/.test(readFileSync(local, 'utf8')) ? 'YES (wrong: that was "don’t ask again")' : 'no';
  } else {
    // macOS 上 /var 是 /private/var 的链接，codex 按真实路径记信任
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'adk-')));
    codexHome = realpathSync(mkdtempSync(join(tmpdir(), 'adk-codex-'))); // pkill 按真实路径匹配
    const real = join(homedir(), '.codex');
    for (const f of ['auth.json', 'config.toml']) if (existsSync(join(real, f))) cpSync(join(real, f), join(codexHome, f));
    const cfg = join(codexHome, 'config.toml');
    writeFileSync(cfg, `${existsSync(cfg) ? readFileSync(cfg, 'utf8') : ''}\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
    execFileSync('git', ['init', '-q'], { cwd });
    // codex 0.164 只剩 on-request / never：命令在沙箱里能跑就不问。让模型显式申请沙箱外运行，才会弹批准提示
    await host.create({ id, cmd: 'codex', args: ['-a', 'on-request', '-s', 'read-only'], cwd, env: { CODEX_HOME: codexHome }, size: { cols: 120, rows: 40 } });
    let s = await waitScreen((x) => /context left|Ask Codex|to send|Trust this folder/i.test(x), 'codex input', 90_000);
    if (/Trust this folder/i.test(s)) {
      // 临时 CODEX_HOME 里的信任，删掉就没了
      result.trustDialog = 'shown, answered with Enter';
      await host.sendKeys(id, ['Enter']);
      s = await waitScreen((x) => /context left|Ask Codex|to send/i.test(x), 'codex input', 60_000);
    }
    await sleep(1500);
    await host.sendKeys(id, [
      `Run exactly this shell command outside the sandbox, requesting escalated permissions (approval) for it, and nothing else: node -e "console.log('ok-from-agentdeck')"`,
    ]);
    await sleep(300);
    await host.sendKeys(id, ['Enter']);
    s = await waitScreen((x) => /Would you like to run|Allow command|Yes, proceed|\(y\)/i.test(x) || /^\s*(?:└|⎿)?\s*ok-from-agentdeck\s*$/m.test(x), 'approval prompt');
    result.prompt = s.split('\n').filter((l) => /run|Yes|No|proceed|\(y\)|\(a\)|esc|node -e/i.test(l)).join(' | ');
    if (!/Would you like to run|Yes, proceed|\(y\)/i.test(s)) throw new Error('codex ran the command without asking');
    result.keys = keys.join(',');
    await host.sendKeys(id, keys); // CodexAdapter.approveOnceKeys = ['y']
    s = await waitScreen((x) => !/Would you like to run/i.test(x), 'prompt to close', 60_000);
    await sleep(3000);
    s = await screen();
    result.afterY = /Would you like to run/i.test(s) ? 'still asking' : 'prompt closed';
    result.ran = /ok-from-agentdeck/.test(s.split('\n').filter((l) => !/node -e/.test(l)).join('\n')) ? 'yes' : 'unclear';
    result.screenTail = s.split('\n').slice(-12).join(' | ');
  }
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e);
} finally {
  result.finalScreen = (await screen().catch(() => '')).split('\n').slice(-25).join('\n');
  await host.killServer();
  await host.dispose();
}

console.log(JSON.stringify(result, null, 2));
if (codexHome) {
  // codex 的守护进程还在往里写，杀掉后多试几次
  for (let i = 0; i < 10; i++) {
    try {
      execFileSync('pkill', ['-9', '-f', codexHome]); // 守护进程不理 SIGTERM（实测）
    } catch {
      // 没有残留进程
    }
    await sleep(500);
    try {
      rmSync(codexHome, { recursive: true, force: true });
      break;
    } catch {
      // 再试
    }
  }
}
process.exit(result.error ? 1 : 0);
