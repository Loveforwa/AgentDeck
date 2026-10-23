// AgentService 的真实实现：检测安装情况，用适配器算出启动命令，再调 TerminalHost.create。

import { AgentDeckError } from '@agentdeck/contracts';
import type {
  AbsPath,
  AgentInfo,
  AgentKind,
  AgentService,
  AgentSessionId,
  StartAgentRequest,
  StartAgentResult,
  TerminalHost,
  TerminalId,
  WorkspaceId,
} from '@agentdeck/contracts';
import type { CommandLaunchContext } from './adapters/shell.ts';
import type { AgentAdapterExt } from './adapters/types.ts';
import type { EnvSource } from './env.ts';
import { findExecutable } from './env.ts';

/**
 * LaunchContext.terminalId 要求在创建前就知道终端 id，但 TerminalHost.create 才分配 id，调用方没法指定。
 * 目前没有适配器用到它（钩子靠 tmux 设的 AGENTDECK_TERM 认终端），先传这个占位值。见 CONTRACT_NOTES.md。
 */
export const PENDING_TERMINAL_ID = 'pending' as TerminalId;

/** 一个 agent 终端开起来之后告诉状态机（StatusMachine.track）。 */
export interface StartedAgent {
  terminalId: TerminalId;
  agent: AgentKind;
  workspaceId: WorkspaceId | null;
  /** 这次启动是否真的带上了钩子。没有时状态靠输出活动判断。 */
  hooks: boolean;
  sessionId: AgentSessionId | null;
}

export interface AgentServiceOptions {
  adapters: AgentAdapterExt[];
  terminals: Pick<TerminalHost, 'create'>;
  /** 登录 shell 的环境，检测自定义命令用。 */
  env: EnvSource;
  /** agentdeck-notify 的绝对路径。 */
  notifyCommand: AbsPath;
  /** Settings › Agents 里的额外启动参数。 */
  extraArgs?: (agent: AgentKind) => string[];
  onStarted?: (started: StartedAgent) => void;
}

export class AgentServiceImpl implements AgentService {
  private readonly adapters: Map<string, AgentAdapterExt>;
  private detection: Promise<AgentInfo[]> | null = null;

  constructor(private readonly opts: AgentServiceOptions) {
    this.adapters = new Map(opts.adapters.map((a) => [a.id, a]));
  }

  list(): Promise<AgentInfo[]> {
    this.detection ??= this.detectAll();
    return this.detection;
  }

  refresh(): Promise<AgentInfo[]> {
    this.detection = this.detectAll();
    return this.detection;
  }

  async start(req: StartAgentRequest): Promise<StartAgentResult> {
    const adapter = this.adapters.get(req.agent);
    if (!adapter) throw new AgentDeckError({ code: 'not-found', message: `Unknown agent: ${req.agent}` });
    const info = (await this.list()).find((a) => a.id === req.agent);
    if (!info?.installed) {
      throw new AgentDeckError({ code: 'command-not-found', message: `Command not found: ${adapter.command}` });
    }
    if (req.mode.kind === 'resume' && !info.capabilities.resume) {
      throw new AgentDeckError({ code: 'unsupported', message: `${adapter.label} can't resume a conversation` });
    }
    if (req.mode.kind === 'fork' && !info.capabilities.fork) {
      throw new AgentDeckError({ code: 'unsupported', message: `${adapter.label} can't fork a conversation` });
    }

    const ctx: CommandLaunchContext = {
      cwd: req.cwd,
      terminalId: PENDING_TERMINAL_ID,
      mode: req.mode,
      notifyCommand: this.opts.notifyCommand,
      extraArgs: this.opts.extraArgs?.(req.agent) ?? [],
      ...(req.command !== undefined ? { command: req.command } : {}),
    };
    const prepared = info.capabilities.hooks ? await adapter.prepare?.(ctx) : undefined;
    const spec = adapter.launch(ctx);
    if (req.agent === 'custom' && !(await findExecutable(spec.cmd, this.opts.env()))) {
      throw new AgentDeckError({ code: 'command-not-found', message: `Command not found: ${spec.cmd}` });
    }

    const { id } = await this.opts.terminals.create({
      cmd: spec.cmd,
      args: spec.args,
      cwd: req.cwd,
      ...(spec.env ? { env: spec.env } : {}),
      ...(req.size ? { size: req.size } : {}),
    });
    this.opts.onStarted?.({
      terminalId: id,
      agent: req.agent,
      workspaceId: req.workspaceId,
      hooks: info.capabilities.hooks && (prepared?.hooks ?? true),
      sessionId: spec.sessionId,
    });
    return { terminalId: id, sessionId: spec.sessionId, cmd: spec.cmd, args: spec.args };
  }

  /** 状态机和 ApprovalService 需要按 agent 找适配器（parseHook、approveOnceKeys）。 */
  adapter(agent: AgentKind): AgentAdapterExt | undefined {
    return this.adapters.get(agent);
  }

  private async detectAll(): Promise<AgentInfo[]> {
    return Promise.all(
      [...this.adapters.values()].map(async (a): Promise<AgentInfo> => {
        try {
          const d = await a.detect();
          return { id: a.id, label: a.label, installed: d.installed, version: d.version, capabilities: a.capabilities(d.version) };
        } catch {
          return { id: a.id, label: a.label, installed: false, version: null, capabilities: a.capabilities(null) };
        }
      }),
    );
  }
}
