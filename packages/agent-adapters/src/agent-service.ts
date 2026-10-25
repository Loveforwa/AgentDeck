// AgentService 的真实实现：检测安装情况，用适配器算出启动命令，再调 TerminalHost.create。

import { AgentDeckError } from '@agentdeck/contracts';
import type {
  AbsPath,
  AgentInfo,
  AgentKind,
  AgentService,
  AgentSessionId,
  McpEndpoint,
  StartAgentRequest,
  StartAgentResult,
  TerminalHost,
  TerminalId,
  WorkspaceId,
} from '@agentdeck/contracts';
import type { CommandLaunchContext } from './adapters/shell.ts';
import type { AdapterLaunchContext, AgentAdapterExt } from './adapters/types.ts';
import type { LaunchSkills } from './skills/types.ts';
import type { EnvSource } from './env.ts';
import { findExecutable } from './env.ts';
import type { ConversationCheck } from './fork.ts';

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
  /** N9：这次带上的 skill 和 MCP（没有 skills 选项、或 shell 时为 null）。组装方据此记下 running。 */
  skills: LaunchSkills | null;
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
  /** AgentDeck 的 MCP 服务（M1）。返回 null 表示没起来，这次启动不挂。 */
  mcp?: () => McpEndpoint | null;
  /**
   * N9：这次启动带哪些 skill 和 MCP（按白板上存的选择，SkillsServiceImpl.prepareLaunch）。不给、返回 null 时和以前一样：
   * 有 mcp 就挂 AgentDeck 的 MCP，不带别的。出错时当作 null（skill 带不上不能让终端起不来）。
   */
  skills?: (req: StartAgentRequest) => Promise<LaunchSkills | null>;
  onStarted?: (started: StartedAgent) => void;
  /**
   * X4：fork 前看原来的对话在不在（fork.ts）。返回 false 时不开终端，抛 not-found；null、出错、不给时照常启动。
   */
  conversationExists?: ConversationCheck;
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
    if (req.mode.kind === 'fork') {
      // 还没说过话的会话没有文件，agent 会报 “No conversation found” 直接退出（X4）
      const found = await this.opts.conversationExists?.(req.agent, req.mode.sessionId).catch(() => null);
      if (found === false) {
        throw new AgentDeckError({
          code: 'not-found',
          message: `No conversation to fork yet. Send ${adapter.label} a message first.`,
          detail: `${req.agent} session ${req.mode.sessionId} has no saved conversation`,
        });
      }
    }

    const skills = (await this.opts.skills?.(req).catch(() => null)) ?? null;
    const ctx: CommandLaunchContext & AdapterLaunchContext = {
      cwd: req.cwd,
      terminalId: PENDING_TERMINAL_ID,
      mode: req.mode,
      notifyCommand: this.opts.notifyCommand,
      extraArgs: this.opts.extraArgs?.(req.agent) ?? [],
      ...(req.command !== undefined ? { command: req.command } : {}),
      ...(req.prompt ? { prompt: req.prompt } : {}),
    };
    const mcp = this.opts.mcp?.();
    // N9：这个终端没勾 built-in 的 agentdeck 时不挂
    if (mcp && (skills?.agentdeckMcp ?? true)) ctx.mcp = mcp;
    if (skills) ctx.skills = skills;
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
      // X6：恢复 Shell 时把上次的命令填进输入行、不运行。只对交互的 shell 有意义（agent 的输入框、-c 跑的命令都不该收到）
      ...(req.agent === 'shell' && req.prefill && req.command === undefined ? { prefill: req.prefill } : {}),
    });
    this.opts.onStarted?.({
      terminalId: id,
      agent: req.agent,
      workspaceId: req.workspaceId,
      hooks: info.capabilities.hooks && (prepared?.hooks ?? true),
      sessionId: spec.sessionId,
      skills,
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
