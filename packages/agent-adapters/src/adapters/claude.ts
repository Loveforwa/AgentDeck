// claude（Claude Code）。钩子通过 `--settings <json>` 临时加上：实测（2.1.291）这里的 hooks 和用户级、项目级的
// hooks 是合并的，两边都会运行，所以不会顶掉用户自己的钩子，也不改任何配置文件。详见 AGENTS.md「钩子实测」。

import { randomUUID } from 'node:crypto';
import type { AgentCapabilities, AgentHookEvent, AgentSessionId, LaunchContext, LaunchSpec } from '@agentdeck/contracts';
import { atLeast, shellQuote } from '../env.ts';
import { parseClaudeNotification, parseCommonHook } from '../hook-payload.ts';
import type { AdapterDeps, AgentAdapterExt, DetectResult } from './types.ts';
import { detectCommand, NO_CAPABILITIES } from './types.ts';

/** PermissionRequest 钩子在 2.0 里才稳定；更老的版本只能靠输出活动判断。粗略下限，待有旧版本时再核对。 */
const MIN_HOOKS_VERSION = '2.0.0';
/** StopFailure（API 出错结束一轮）是较新的事件，老版本遇到不认识的事件名可能整份 settings 作废，所以按版本加。粗略下限。 */
const MIN_STOP_FAILURE_VERSION = '2.1.0';

/** PermissionRequest 等 AgentDeck 回答；notify 自己 2 秒超时，这里给 claude 的上限留点余量（秒）。 */
const PERMISSION_HOOK_TIMEOUT_S = 5;
/** 其他钩子只发不等，正常 100ms 内结束（秒）。 */
const HOOK_TIMEOUT_S = 3;

export interface ClaudeAdapterOptions extends AdapterDeps {
  /** 测试里固定会话 id。 */
  newSessionId?: () => string;
}

export class ClaudeAdapter implements AgentAdapterExt {
  readonly id = 'claude';
  readonly label = 'Claude Code';
  readonly command = 'claude';
  /** “1. Yes” = 允许一次。发 '1' 而不是 Enter：Enter 选的是当前高亮的那一行，用户按过方向键时可能变成“以后都允许”（线 1 实测，tmux-host/AGENTS.md「Approve all 的按键核对」）。 */
  readonly approveOnceKeys = ['1'];
  private lastVersion: string | null = null;
  private readonly newSessionId: () => string;

  constructor(private readonly deps: ClaudeAdapterOptions) {
    this.newSessionId = deps.newSessionId ?? randomUUID;
  }

  async detect(): Promise<DetectResult> {
    const r = await detectCommand(this.command, this.deps);
    this.lastVersion = r.version;
    return r;
  }

  capabilities(version: string | null): AgentCapabilities {
    if (!atLeast(version, MIN_HOOKS_VERSION)) return { ...NO_CAPABILITIES, resume: true, fork: true };
    return { hooks: true, resume: true, fork: true, askTool: true };
  }

  launch(ctx: LaunchContext): LaunchSpec {
    const args: string[] = [];
    let sessionId: string;
    switch (ctx.mode.kind) {
      case 'new':
        sessionId = this.newSessionId();
        args.push('--session-id', sessionId);
        break;
      case 'resume':
        sessionId = ctx.mode.sessionId;
        args.push('--resume', sessionId);
        break;
      case 'fork':
        // 实测 --fork-session 可以和 --session-id 一起用：新会话就用我们给的 id，启动时就知道。
        sessionId = this.newSessionId();
        args.push('--resume', ctx.mode.sessionId, '--fork-session', '--session-id', sessionId);
        break;
    }
    if (this.capabilities(this.lastVersion).hooks) {
      args.push('--settings', JSON.stringify(claudeHookSettings(ctx.notifyCommand, this.lastVersion)));
    }
    args.push(...ctx.extraArgs);
    return {
      cmd: this.command,
      args,
      // claude 在 tmux 里检测到 $TMUX 会自己降到 256 色（docs/decisions.md）。
      env: { CLAUDE_CODE_TMUX_TRUECOLOR: '1' },
      sessionId: sessionId as AgentSessionId,
    };
  }

  parseHook(hookName: string, payload: unknown): AgentHookEvent | null {
    switch (hookName) {
      case 'Notification':
        return parseClaudeNotification(payload);
      case 'StopFailure':
        return { type: 'turn-end' };
      default:
        return parseCommonHook(hookName, payload);
    }
  }
}

/** 注入的钩子事件。PostToolUse 用来在批准、回答之后回到 running；它是同步的，保证比同一轮的 Stop 先到。 */
export function claudeHookEvents(version: string | null): string[] {
  const events = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
  if (atLeast(version, MIN_STOP_FAILURE_VERSION)) events.push('StopFailure');
  return events;
}

/** `--settings` 的内容：每个事件一条不带 matcher 的命令钩子，运行 `agentdeck-notify claude <事件名>`。 */
export function claudeHookSettings(notifyCommand: string, version: string | null): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const event of claudeHookEvents(version)) {
    hooks[event] = [
      {
        hooks: [
          {
            type: 'command',
            command: `${shellQuote(notifyCommand)} claude ${event}`,
            timeout: event === 'PermissionRequest' ? PERMISSION_HOOK_TIMEOUT_S : HOOK_TIMEOUT_S,
          },
        ],
      },
    ];
  }
  return { hooks };
}
