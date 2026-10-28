// claude（Claude Code）。钩子通过 `--settings <json>` 临时加上：实测（2.1.291）这里的 hooks 和用户级、项目级的
// hooks 是合并的，两边都会运行，所以不会顶掉用户自己的钩子，也不改任何配置文件。详见 AGENTS.md「钩子实测」。

import { randomUUID } from 'node:crypto';
import { MCP_SERVER_NAME, MCP_TERMINAL_HEADER, MCP_TOKEN_ENV, TERMINAL_ID_ENV } from '@agentdeck/contracts';
import type { AgentCapabilities, AgentHookEvent, AgentSessionId, CapabilityEntry, LaunchSpec, McpEndpoint } from '@agentdeck/contracts';
import { no, statusFromActivity, yes } from '../capabilities/declare.ts';
import { atLeast, shellQuote } from '../env.ts';
import { parseClaudeNotification, parseClaudeStopFailure, parseCommonHook } from '../hook-payload.ts';
import type { McpServerDef } from '../skills/types.ts';
import type { AdapterDeps, AdapterLaunchContext, AgentAdapterExt, DetectResult, LaunchFlag } from './types.ts';
import { detectWithHelp, NO_CAPABILITIES } from './types.ts';

/** PermissionRequest 钩子在 2.0 里才稳定；更老的版本只能靠输出活动判断。粗略下限，待有旧版本时再核对。 */
const MIN_HOOKS_VERSION = '2.0.0';
/** StopFailure（API 出错结束一轮）是较新的事件，老版本遇到不认识的事件名可能整份 settings 作废，所以按版本加。粗略下限。 */
const MIN_STOP_FAILURE_VERSION = '2.1.0';
/** SubagentStart / SubagentStop（N10 后台 agent）。2.1.291 实测有；确知更老的版本不带（没核对过，免得认不出的钩子让设置报错）。不知道版本时照 atLeast 的规矩按新版带上。 */
const MIN_SUBAGENT_HOOKS_VERSION = '2.1.0';

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
  /** 读不出版本时的 --help 输出（AH3：按它决定带不带 --settings）。 */
  private lastHelp: string | null = null;
  private readonly newSessionId: () => string;

  constructor(private readonly deps: ClaudeAdapterOptions) {
    this.newSessionId = deps.newSessionId ?? randomUUID;
  }

  async detect(): Promise<DetectResult> {
    const { result, help } = await detectWithHelp(this.command, this.deps);
    this.lastVersion = result.version;
    this.lastHelp = help;
    return result;
  }

  capabilities(version: string | null): AgentCapabilities {
    if (!this.hooksFor(version)) return { ...NO_CAPABILITIES, resume: true, fork: true };
    return { hooks: true, resume: true, fork: true, askTool: true };
  }

  /** AH3：Check again 在 --help 里找的参数。 */
  launchFlags(version: string | null): LaunchFlag[] {
    return [
      { flag: '--session-id', keys: ['session-id', 'first-prompt'] },
      { flag: '--resume', keys: ['resume', 'fork'] },
      { flag: '--fork-session', keys: ['fork'] },
      ...(this.hooksFor(version) ? [{ flag: '--settings', keys: ['status', 'approval-wait', 'question', 'approve-keys', 'subagents'] } satisfies LaunchFlag] : []),
      { flag: '--mcp-config', keys: ['agentdeck-mcp'] },
      { flag: '--plugin-dir', keys: ['skills'] },
      { flag: '--append-system-prompt', keys: ['append-instructions'] },
    ];
  }

  /** 钩子（--settings）：版本够新，或者读不出版本但 --help 里有 --settings。 */
  private hooksFor(version: string | null): boolean {
    return atLeast(version, MIN_HOOKS_VERSION, version === null ? { text: this.lastHelp, flag: '--settings' } : null);
  }

  /** AH0 / AH2：能力声明（画布 A0 第 2 节）。合格测试按它逐项跑（test/conformance）。 */
  declareCapabilities(version: string | null): CapabilityEntry[] {
    const hooks = this.hooksFor(version);
    const needHooks = version === null ? "Couldn't read the Claude Code version" : `Needs Claude Code ${MIN_HOOKS_VERSION} or later`;
    return [
      yes('first-prompt', 'flag'),
      hooks ? yes('status', 'hook') : statusFromActivity(`${needHooks}; status comes from terminal activity`),
      hooks ? yes('approval-wait', 'hook') : no('approval-wait', needHooks),
      hooks ? yes('question', 'hook') : no('question', needHooks),
      yes('session-id', 'flag'),
      yes('resume', 'flag'),
      yes('fork', 'flag'),
      yes('history', 'session-file'),
      yes('usage', 'session-file'),
      // 额度（PL3 的队列插件读 rate_limit 行）还没进这条分支；合进来后改成 partial · session-file
      no('quota', 'Not read for Claude Code yet'),
      hooks ? yes('approve-keys', 'hook') : no('approve-keys', needHooks),
      yes('agentdeck-mcp', 'flag'),
      yes('skills', 'extension'),
      atLeast(version, MIN_SUBAGENT_HOOKS_VERSION) ? yes('subagents', 'hook') : no('subagents', `Needs Claude Code ${MIN_SUBAGENT_HOOKS_VERSION} or later`),
      // --append-system-prompt（2.1.291 --help）
      yes('append-instructions', 'flag'),
      yes('shell-tool', null),
    ];
  }

  launch(ctx: AdapterLaunchContext): LaunchSpec {
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
    // AH3：只带会话参数重开时（IS-73）钩子、skill、MCP、用户参数都不带
    const full = !ctx.sessionOnly;
    if (full && this.hooksFor(this.lastVersion)) {
      args.push('--settings', JSON.stringify(claudeHookSettings(ctx.notifyCommand, this.lastVersion)));
    }
    // claude 在 tmux 里检测到 $TMUX 会自己降到 256 色（docs/decisions.md）。
    const env: Record<string, string> = { CLAUDE_CODE_TMUX_TRUECOLOR: '1' };
    // N9：选中的 skill 在那套目录的 skills/ 里，--plugin-dir 只对这次会话有效（2.1.291 实测），不写 ~/.claude
    const skills = full ? ctx.skills : undefined;
    if (skills?.setDir && skills.skills.length > 0) args.push('--plugin-dir', skills.setDir);
    const library = skills?.mcp ?? [];
    const mcp = full ? ctx.mcp : undefined;
    if (mcp || library.length > 0) {
      args.push('--mcp-config', JSON.stringify(claudeMcpConfig(mcp ?? null, library)));
      if (mcp) env[MCP_TOKEN_ENV] = mcp.token;
    }
    if (full) args.push(...ctx.extraArgs);
    // --mcp-config 和不少用户参数后面能跟多个值，提示词放在 -- 之后才不会被吃掉（2.1.291 实测）。
    const prompt = ctx.prompt && ctx.mode.kind === 'new' ? ctx.prompt : null;
    if (prompt) args.push('--', prompt);
    return { cmd: this.command, args, env, sessionId: sessionId as AgentSessionId, consumed: { prompt: prompt !== null } };
  }

  parseHook(hookName: string, payload: unknown): AgentHookEvent | null {
    switch (hookName) {
      case 'Notification':
        return parseClaudeNotification(payload);
      case 'StopFailure':
        return parseClaudeStopFailure(payload);
      default:
        return parseCommonHook(hookName, payload);
    }
  }
}

/**
 * 注入的钩子事件。PostToolUse 用来在批准、回答之后回到 running；它是同步的，保证比同一轮的 Stop 先到。
 * SubagentStart / SubagentStop 只给后台 agent 模块（N10）用，状态机不认它们。
 */
export function claudeHookEvents(version: string | null): string[] {
  const events = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
  if (atLeast(version, MIN_STOP_FAILURE_VERSION)) events.push('StopFailure');
  if (atLeast(version, MIN_SUBAGENT_HOOKS_VERSION)) events.push('SubagentStart', 'SubagentStop');
  return events;
}

/**
 * `--settings` 的内容：每个事件一条不带 matcher 的命令钩子，运行 `agentdeck-notify claude <事件名>`。
 * 另外把主题设成 auto（IS-42）：用户在 ~/.claude.json 里的主题是给他平时的终端选的，在 AgentDeck 里背景跟着
 * 白板的深浅色走。设成 light 的用户在深色白板上会看到黑字（问题标题、选项都看不清）。auto 时 claude 用 OSC 11
 * 问背景色（终端组件替 xterm 回答），深浅色切换时收到 tmux 转来的 CSI ? 997 n 再问一次。
 * 实测（2.1.291）这里的 theme 盖过 ~/.claude.json 的 theme，不改配置文件；色弱、ANSI 变体会被换成普通的深浅色。
 */
export function claudeHookSettings(notifyCommand: string, version: string | null): { hooks: Record<string, unknown[]>; theme: 'auto' } {
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
  return { hooks, theme: 'auto' };
}

/**
 * `--mcp-config` 的内容。token 和终端 id 写成 `${…}`，由 claude 从环境里展开（2.1.291 实测），不出现在命令行上。
 * 和用户自己配的 MCP 合并，不用 --strict-mcp-config。
 * library（N9）：AgentDeck 库里选中的 MCP 服务，写在同一份配置里。mcp 为 null 时（服务没起来、或这个终端没勾 agentdeck）只有它们。
 */
export function claudeMcpConfig(mcp: McpEndpoint | null, library: readonly McpServerDef[] = []): { mcpServers: Record<string, unknown> } {
  const servers: Record<string, unknown> = {};
  if (mcp) {
    servers[MCP_SERVER_NAME] = {
      type: 'http',
      url: mcp.url,
      headers: {
        Authorization: `Bearer \${${MCP_TOKEN_ENV}}`,
        [MCP_TERMINAL_HEADER]: `\${${TERMINAL_ID_ENV}}`,
      },
    };
  }
  for (const d of library) {
    servers[d.name] = d.transport === 'http' ? { type: 'http', url: d.url } : { type: 'stdio', command: d.command, args: d.args };
  }
  return { mcpServers: servers };
}
