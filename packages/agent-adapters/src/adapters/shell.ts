// Shell 和自定义命令：没有钩子，状态只靠 tmux 的输出活动和退出码。

import { AgentDeckError } from '@agentdeck/contracts';
import type { AgentCapabilities, AgentHookEvent, LaunchContext, LaunchSpec } from '@agentdeck/contracts';
import { findExecutable, splitCommand } from '../env.ts';
import type { AdapterDeps, AgentAdapterExt, DetectResult } from './types.ts';
import { NO_CAPABILITIES, unsupported } from './types.ts';

/**
 * contracts 的 LaunchContext 没有“要运行的命令”，Shell 和自定义命令需要它（StartAgentRequest.command）。
 * AgentService 把它放在这个扩展字段里传进来，见 CONTRACT_NOTES.md。
 */
export interface CommandLaunchContext extends LaunchContext {
  command?: string;
}

const DEFAULT_SHELL = '/bin/zsh';

export class ShellAdapter implements AgentAdapterExt {
  readonly id = 'shell';
  readonly label = 'Shell';
  readonly approveOnceKeys = null;

  constructor(private readonly deps: AdapterDeps) {}

  /** 用户的登录 shell（环境里的 SHELL），没有就用 zsh（macOS 默认）。 */
  get command(): string {
    return this.deps.env().SHELL || DEFAULT_SHELL;
  }

  async detect(): Promise<DetectResult> {
    const path = await findExecutable(this.command, this.deps.env());
    return { installed: path !== null, version: null, path };
  }

  capabilities(): AgentCapabilities {
    return NO_CAPABILITIES;
  }

  launch(ctx: CommandLaunchContext): LaunchSpec {
    if (ctx.mode.kind !== 'new') unsupported(this.label, ctx.mode);
    const command = ctx.command?.trim();
    // 带命令（例如工作区的 setupCommand、pnpm dev）时用 -c 跑它，命令结束 shell 也结束，退出码就是命令的。
    const args = command ? ['-l', '-c', command] : ['-l'];
    return { cmd: this.command, args: [...args, ...ctx.extraArgs], sessionId: null };
  }

  parseHook(): AgentHookEvent | null {
    return null;
  }
}

export class CustomCommandAdapter implements AgentAdapterExt {
  readonly id = 'custom';
  readonly label = 'Custom command';
  /** 没有固定命令；每次启动由 StartAgentRequest.command 给。 */
  readonly command = '';
  readonly approveOnceKeys = null;

  async detect(): Promise<DetectResult> {
    // 命令每次不同，没法事先检测；启动时再查（AgentService.start 找不到会抛 command-not-found）。
    return { installed: true, version: null, path: null };
  }

  capabilities(): AgentCapabilities {
    return NO_CAPABILITIES;
  }

  launch(ctx: CommandLaunchContext): LaunchSpec {
    if (ctx.mode.kind !== 'new') unsupported(this.label, ctx.mode);
    const [cmd, ...args] = splitCommand(ctx.command ?? '');
    if (!cmd) throw new AgentDeckError({ code: 'invalid-argument', message: 'Enter a command to run' });
    return { cmd, args: [...args, ...ctx.extraArgs], sessionId: null };
  }

  parseHook(): AgentHookEvent | null {
    return null;
  }
}
