// codex（OpenAI Codex CLI）。
//
// 钩子（0.159 起 hooks 是 stable）：启动时用 `-c hooks.<事件>=[...]` 临时加上，不改 ~/.codex/config.toml。
// codex 只运行“信任过”的钩子：每条钩子有一个哈希，信任记录在用户配置的 hooks.state 里。
// 我们不去写用户配置，而是在启动前用 `codex app-server` 的 hooks/list 问出这几条钩子的 key 和哈希，
// 再用 `-c hooks.state={...}` 把它们（只是它们）标成信任。哈希的算法是 codex 内部的，所以不自己算，靠它自己报。
// 用户、项目里没审过的钩子照样不会运行（没有用 --dangerously-bypass-hook-trust）。
// 带 -c 启动时 codex 不连共享的后台服务（embedded mode），会显示一条 Startup 警告，不影响使用。
//
// 准备失败（app-server 不通、超时）时这次启动不加钩子，状态退回按输出活动判断。
// 更老、没有 hooks 的版本用 legacy notify：`-c notify=[...]`，只知道一轮结束。注意它会顶掉用户自己的 notify 设置。

import { spawn } from 'node:child_process';
import type { AgentCapabilities, AgentHookEvent, AgentSessionId, LaunchContext, LaunchSpec } from '@agentdeck/contracts';
import { atLeast, findExecutable, shellQuote } from '../env.ts';
import { parseCommonHook } from '../hook-payload.ts';
import type { AdapterDeps, AgentAdapterExt, DetectResult } from './types.ts';
import { detectCommand, NO_CAPABILITIES } from './types.ts';

/** 本机实测有 hooks 和 hooks/list 的版本。更早的版本可能也有，没验证过就按没有处理。 */
const MIN_HOOKS_VERSION = '0.159.0';
/** `codex resume <id>`、`codex fork <id>` 在 0.159 上实测可用。 */
const MIN_FORK_VERSION = '0.159.0';

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  // 用户按 Esc 打断、或在确认框里选 No 时触发（实测）。没有它，拒绝批准后状态会一直停在 needs-approval。
  'Interrupt',
  'SessionEnd',
] as const;

const PERMISSION_HOOK_TIMEOUT_S = 5;
const HOOK_TIMEOUT_S = 3;
const APP_SERVER_TIMEOUT_MS = 10_000;

export interface CodexHookTrust {
  key: string;
  hash: string;
}

/** 用 app-server 问钩子的 key 和哈希。测试里换成假的。 */
export type CodexTrustQuery = (q: {
  codexPath: string;
  env: Record<string, string>;
  cwd: string;
  overrides: string[];
}) => Promise<{ command: string; key: string; hash: string; source: string }[]>;

export interface CodexAdapterOptions extends AdapterDeps {
  queryTrust?: CodexTrustQuery;
}

export class CodexAdapter implements AgentAdapterExt {
  readonly id = 'codex';
  readonly label = 'Codex';
  readonly command = 'codex';
  /** 确认框写着 “1. Yes, proceed (y)”，按 y 即“允许一次”（0.159.2 实测）。待线 1 用真终端核对 send-keys 的效果。 */
  readonly approveOnceKeys = ['y'];
  private lastVersion: string | null = null;
  private lastPath: string | null = null;
  /** notifyCommand → 每条钩子命令的信任记录。哈希只和钩子配置有关，同一个 notify 路径算一次就够。 */
  private readonly trustCache = new Map<string, CodexHookTrust[]>();
  private readonly queryTrust: CodexTrustQuery;

  constructor(private readonly deps: CodexAdapterOptions) {
    this.queryTrust = deps.queryTrust ?? queryTrustViaAppServer;
  }

  async detect(): Promise<DetectResult> {
    const r = await detectCommand(this.command, this.deps);
    this.lastVersion = r.version;
    this.lastPath = r.path;
    return r;
  }

  capabilities(version: string | null): AgentCapabilities {
    const fork = atLeast(version, MIN_FORK_VERSION);
    if (!atLeast(version, MIN_HOOKS_VERSION)) return { ...NO_CAPABILITIES, resume: true, fork };
    // codex 的 request_user_input 还在开发中（features list 里是 under development），先不认提问。
    return { hooks: true, resume: true, fork, askTool: false };
  }

  /** 问出钩子的信任哈希。返回这次启动是否带钩子。 */
  async prepare(ctx: LaunchContext): Promise<{ hooks: boolean }> {
    if (!this.capabilities(this.lastVersion).hooks) return { hooks: false };
    if (this.trustCache.has(ctx.notifyCommand)) return { hooks: true };
    try {
      const env = this.deps.env();
      const codexPath = this.lastPath ?? (await findExecutable(this.command, env));
      if (!codexPath) return { hooks: false };
      const overrides = codexHookOverrides(ctx.notifyCommand);
      const listed = await this.queryTrust({ codexPath, env, cwd: ctx.cwd, overrides });
      const commands = new Set(CODEX_HOOK_EVENTS.map((e) => hookCommand(ctx.notifyCommand, e)));
      const ours = listed.filter((h) => h.source === 'sessionFlags' && commands.has(h.command));
      if (ours.length !== CODEX_HOOK_EVENTS.length) return { hooks: false };
      this.trustCache.set(
        ctx.notifyCommand,
        ours.map((h) => ({ key: h.key, hash: h.hash })),
      );
      return { hooks: true };
    } catch {
      return { hooks: false };
    }
  }

  launch(ctx: LaunchContext): LaunchSpec {
    const head: string[] = [];
    let sessionId: string | null = null;
    if (ctx.mode.kind === 'resume') {
      head.push('resume', ctx.mode.sessionId);
      sessionId = ctx.mode.sessionId;
    } else if (ctx.mode.kind === 'fork') {
      // fork 出来的新会话 id 要等 SessionStart 钩子才知道。
      head.push('fork', ctx.mode.sessionId);
    }
    const trust = this.trustCache.get(ctx.notifyCommand);
    let hookArgs: string[] = [];
    if (trust) {
      hookArgs = [...codexHookOverrides(ctx.notifyCommand), '-c', `hooks.state=${trustTable(trust)}`];
    } else if (!this.capabilities(this.lastVersion).hooks) {
      hookArgs = ['-c', `notify=[${toml(ctx.notifyCommand)},"codex","notify"]`];
    }
    return {
      cmd: this.command,
      args: [...head, ...hookArgs, ...ctx.extraArgs],
      sessionId: sessionId as AgentSessionId | null,
    };
  }

  parseHook(hookName: string, payload: unknown): AgentHookEvent | null {
    switch (hookName) {
      case 'Interrupt':
        return { type: 'turn-end' };
      case 'notify': {
        // legacy notify：{"type":"agent-turn-complete","thread-id":...}
        const type = (payload as { type?: unknown } | null)?.type;
        return type === 'agent-turn-complete' ? { type: 'turn-end' } : null;
      }
      default:
        return parseCommonHook(hookName, payload);
    }
  }
}

function hookCommand(notifyCommand: string, event: string): string {
  return `${shellQuote(notifyCommand)} codex ${event}`;
}

/** TOML 基本字符串。JSON 的字符串转义是 TOML 基本字符串的子集。 */
function toml(s: string): string {
  return JSON.stringify(s);
}

/** `-c hooks.<事件>=[{hooks=[{type="command",command="...",timeout=N}]}]`，每个事件一对参数。 */
export function codexHookOverrides(notifyCommand: string): string[] {
  return CODEX_HOOK_EVENTS.flatMap((event) => {
    const timeout = event === 'PermissionRequest' ? PERMISSION_HOOK_TIMEOUT_S : HOOK_TIMEOUT_S;
    return ['-c', `hooks.${event}=[{hooks=[{type="command",command=${toml(hookCommand(notifyCommand, event))},timeout=${timeout}}]}]`];
  });
}

/**
 * `hooks.state={"<key>"={trusted_hash="sha256:..."},...}`。
 * 要写成整张内联表：key 里有 “.”（`/<session-flags>/config.toml:stop:0:0`），用点号路径写会被拆开。
 * session flags 这一层的 hooks.state 和用户配置里的按字段合并，不会抹掉用户自己的记录（codex 源码 config_rules.rs）。
 */
function trustTable(trust: CodexHookTrust[]): string {
  return `{${trust.map((t) => `${toml(t.key)}={trusted_hash=${toml(t.hash)}}`).join(',')}}`;
}

/** 起一个 `codex app-server`（stdio，一行一个 JSON-RPC 消息），调 hooks/list。 */
export const queryTrustViaAppServer: CodexTrustQuery = ({ codexPath, env, cwd, overrides }) =>
  new Promise((resolve, reject) => {
    const child = spawn(codexPath, ['app-server', ...overrides], { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let done = false;
    const finish = (err: Error | null, value?: Awaited<ReturnType<CodexTrustQuery>>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value ?? []);
    };
    const timer = setTimeout(() => finish(new Error('codex app-server timed out')), APP_SERVER_TIMEOUT_MS);
    child.on('error', (e) => finish(e));
    child.on('exit', () => finish(new Error('codex app-server exited')));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg: { id?: unknown; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id !== 2) continue;
        if (msg.error) return finish(new Error(`hooks/list failed: ${JSON.stringify(msg.error)}`));
        return finish(null, parseHooksList(msg.result));
      }
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agentdeck', version: '0.1.0' } } });
    send({ method: 'initialized' });
    send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
  });

/** hooks/list 的结果：{ data: [{ cwd, hooks: [{ key, command, currentHash, source, ... }] }] }。 */
export function parseHooksList(result: unknown): { command: string; key: string; hash: string; source: string }[] {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry: { hooks?: unknown }) =>
    (Array.isArray(entry?.hooks) ? entry.hooks : []).flatMap((h: Record<string, unknown>) =>
      typeof h.key === 'string' && typeof h.command === 'string' && typeof h.currentHash === 'string'
        ? [{ command: h.command, key: h.key, hash: h.currentHash, source: String(h.source ?? '') }]
        : [],
    ),
  );
}
