// AgentService 的真实实现：检测安装情况，用适配器算出启动命令，再调 TerminalHost.create。

import { randomBytes } from 'node:crypto';
import { delimiter } from 'node:path';
import { AgentDeckError, TERMINAL_KEY_ENV } from '@agentdeck/contracts';
import type {
  AgentCapabilityReport,
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
  /**
   * CR15（IS-101）：这个终端的钥匙（组装时接 mcp-server 的 terminalKey）。给了就在启动前生成终端 id（CreateTerminalRequest.id），
   * 钥匙放进环境的 AGENTDECK_TERM_KEY，挂 AgentDeck MCP 时也用它代替共用 token（MCP 配置里的 ${AGENTDECK_MCP_TOKEN} 展开成钥匙），
   * 终端环境里就没有共用的密钥了。返回 null 时这个终端不带钥匙。
   */
  terminalKey?: (terminalId: TerminalId) => string | null;
  /** CR15：agentdeck 命令所在的目录（<数据目录>/bin），放在每个 AgentDeck 终端 PATH 的最前面。系统自己的终端不受影响。 */
  binDir?: AbsPath;
}

/** 改 PATH 时经它启动（见 start）。macOS 和 Linux 都在这里。 */
const ENV_COMMAND = '/usr/bin/env';

/** 和 tmux-host 生成的 id 同一个样子。 */
function newTerminalId(): TerminalId {
  return `t-${randomBytes(6).toString('hex')}` as TerminalId;
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

  /** AH0 的 Check again 还没做（能力报告由 AH0、AH2、AH3 填），先占位。 */
  async check(agent: AgentKind): Promise<AgentCapabilityReport> {
    if (!this.adapters.has(agent)) throw new AgentDeckError({ code: 'not-found', message: `Unknown agent: ${agent}` });
    throw new AgentDeckError({ code: 'unsupported', message: 'Check again isn’t available yet' });
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
    // CR15：要给终端钥匙时先定下终端 id（钥匙由它算）
    const terminalId = this.opts.terminalKey ? newTerminalId() : null;
    const key = terminalId ? this.opts.terminalKey!(terminalId) : null;
    const ctx: CommandLaunchContext & AdapterLaunchContext = {
      cwd: req.cwd,
      terminalId: terminalId ?? PENDING_TERMINAL_ID,
      mode: req.mode,
      notifyCommand: this.opts.notifyCommand,
      extraArgs: this.opts.extraArgs?.(req.agent) ?? [],
      ...(req.command !== undefined ? { command: req.command } : {}),
      ...(req.prompt ? { prompt: req.prompt } : {}),
    };
    const mcp = this.opts.mcp?.();
    // N9：这个终端没勾 built-in 的 agentdeck 时不挂。CR15：有钥匙时 MCP 也按钥匙认（共用 token 不进终端环境）
    if (mcp && (skills?.agentdeckMcp ?? true)) ctx.mcp = key ? { url: mcp.url, token: key } : mcp;
    if (skills) ctx.skills = skills;
    const prepared = info.capabilities.hooks ? await adapter.prepare?.(ctx) : undefined;
    const spec = adapter.launch(ctx);
    if (req.agent === 'custom' && !(await findExecutable(spec.cmd, this.opts.env()))) {
      throw new AgentDeckError({ code: 'command-not-found', message: `Command not found: ${spec.cmd}` });
    }

    const env = this.terminalEnv(spec.env, key);
    // tmux 3.6a 不认 new-session -e PATH=…（窗格的 PATH 取 tmux 客户端自己的，实测），所以 PATH 要改时经 /usr/bin/env 设好再 exec。
    // 窗口里记的、返回的仍是原来的 cmd / args；env exec 之后窗格里的进程就是程序本身。
    const launch = env?.PATH && env.PATH !== spec.env?.PATH ? { cmd: ENV_COMMAND, args: [`PATH=${env.PATH}`, spec.cmd, ...spec.args] } : spec;
    const { id } = await this.opts.terminals.create({
      ...(terminalId ? { id: terminalId } : {}),
      cmd: launch.cmd,
      args: launch.args,
      cwd: req.cwd,
      ...(env ? { env } : {}),
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

  /**
   * CR15：每个 AgentDeck 终端（agent、Shell、自定义命令都算，pi、kimi 也是）都加的环境：PATH 前面是 binDir（agentdeck 命令），
   * AGENTDECK_TERM_KEY 是这个终端的钥匙。只放进这个终端的 LaunchSpec.env，不写任何配置文件。
   */
  private terminalEnv(env: Record<string, string> | undefined, key: string | null): Record<string, string> | undefined {
    const binDir = this.opts.binDir;
    if (!binDir && !key) return env;
    const base = env?.PATH ?? this.opts.env().PATH ?? '';
    return {
      ...env,
      ...(binDir ? { PATH: [binDir, ...base.split(delimiter).filter((d) => d && d !== binDir)].join(delimiter) } : {}),
      ...(key ? { [TERMINAL_KEY_ENV]: key } : {}),
    };
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
