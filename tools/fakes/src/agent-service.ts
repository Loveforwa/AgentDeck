// AgentService 的假实现：算出和真适配器相近的启动命令，再在 FakeTerminalHost 里开终端。

import type {
  AgentCapabilities,
  AgentInfo,
  AgentKind,
  AgentService,
  AgentSessionId,
  LaunchMode,
  StartAgentRequest,
  StartAgentResult,
} from '@agentdeck/contracts';
import type { FakeStatusService } from './status-service.ts';
import type { FakeTerminalHost } from './terminal-host.ts';
import { clone, fail, idGenerator } from './util.ts';

export interface FakeAgentDefinition {
  info: AgentInfo;
  /** 发给 tmux 的“允许一次”按键；null 表示不支持 Approve all。 */
  approveOnceKeys: string[] | null;
}

const ALL: AgentCapabilities = { hooks: true, resume: true, fork: true, askTool: true };
const NONE: AgentCapabilities = { hooks: false, resume: false, fork: false, askTool: false };

export const DEFAULT_AGENTS: FakeAgentDefinition[] = [
  { info: { id: 'claude', label: 'Claude Code', installed: true, version: '2.1.0', capabilities: ALL }, approveOnceKeys: ['Enter'] },
  {
    info: { id: 'codex', label: 'Codex', installed: true, version: '0.50.0', capabilities: { ...ALL, askTool: false } },
    approveOnceKeys: ['y'],
  },
  { info: { id: 'gemini', label: 'Gemini CLI', installed: false, version: null, capabilities: NONE }, approveOnceKeys: null },
  { info: { id: 'shell', label: 'Shell', installed: true, version: null, capabilities: NONE }, approveOnceKeys: null },
];

export interface FakeAgentServiceOptions {
  terminals: FakeTerminalHost;
  /** 给了就在 start 时开始跟踪状态（starting）。 */
  status?: FakeStatusService;
  agents?: FakeAgentDefinition[];
  /** Shell 用的程序，默认 /bin/zsh。 */
  shell?: string;
  /** 每种 agent 额外的启动参数（Settings › Agents）。 */
  extraArgs?: (agent: AgentKind) => string[];
}

export class FakeAgentService implements AgentService {
  private readonly terminals: FakeTerminalHost;
  private readonly status: FakeStatusService | undefined;
  private readonly agents: FakeAgentDefinition[];
  private readonly shell: string;
  private readonly extraArgs: (agent: AgentKind) => string[];
  private readonly nextId = idGenerator();
  /** 每次 start 的请求和结果，测试里断言用。 */
  readonly started: { request: StartAgentRequest; result: StartAgentResult }[] = [];

  constructor(opts: FakeAgentServiceOptions) {
    this.terminals = opts.terminals;
    this.status = opts.status;
    this.agents = clone(opts.agents ?? DEFAULT_AGENTS);
    this.shell = opts.shell ?? '/bin/zsh';
    this.extraArgs = opts.extraArgs ?? (() => []);
  }

  async list(): Promise<AgentInfo[]> {
    return this.agents.map((a) => clone(a.info));
  }

  async refresh(): Promise<AgentInfo[]> {
    return this.list();
  }

  async start(req: StartAgentRequest): Promise<StartAgentResult> {
    const { cmd, args, sessionId } = this.launch(req);
    const terminalId = this.terminals.createWith({
      cmd,
      args,
      cwd: req.cwd,
      env: { AGENTDECK_AGENT: req.agent },
      ...(req.size ? { size: req.size } : {}),
      // X6：和真实现一样，只有交互的 shell 收 prefill
      ...(req.agent === 'shell' && req.prefill && req.command === undefined ? { prefill: req.prefill } : {}),
    });
    this.status?.track(terminalId, { agent: req.agent, workspaceId: req.workspaceId });
    const result: StartAgentResult = { terminalId, sessionId, cmd, args };
    this.started.push({ request: clone(req), result: clone(result) });
    return clone(result);
  }

  // ---- 假实现专用 ----

  approveOnceKeys(agent: AgentKind): string[] | null {
    return this.agents.find((a) => a.info.id === agent)?.approveOnceKeys ?? null;
  }

  /** 改一个 agent 的安装情况或能力，演示“没装”“旧版没有钩子”用。 */
  setAgent(id: AgentKind, patch: Partial<AgentInfo>): void {
    const a = this.agents.find((x) => x.info.id === id);
    if (!a) fail('not-found', `Unknown agent ${id}`);
    a.info = { ...a.info, ...clone(patch) };
  }

  // ---- 内部 ----

  private launch(req: StartAgentRequest): { cmd: string; args: string[]; sessionId: AgentSessionId | null } {
    if (req.agent === 'custom') {
      const parts = (req.command ?? '').trim().split(/\s+/).filter(Boolean);
      const [cmd, ...args] = parts;
      if (!cmd) fail('invalid-argument', 'Enter a command to run');
      return { cmd, args, sessionId: null };
    }
    const def = this.agents.find((a) => a.info.id === req.agent);
    if (!def) fail('not-found', `Unknown agent ${req.agent}`);
    if (!def.info.installed) fail('command-not-found', `${def.info.label} is not installed`);
    checkMode(def.info, req.mode);
    const extra = this.extraArgs(req.agent);
    switch (req.agent) {
      case 'shell':
        return { cmd: this.shell, args: req.command ? ['-lc', req.command] : ['-l'], sessionId: null };
      case 'claude': {
        if (req.mode.kind === 'resume') return { cmd: 'claude', args: ['--resume', req.mode.sessionId, ...extra], sessionId: req.mode.sessionId };
        const sessionId = this.nextId<AgentSessionId>('session');
        const fork = req.mode.kind === 'fork' ? ['--resume', req.mode.sessionId, '--fork-session'] : [];
        return { cmd: 'claude', args: [...fork, '--session-id', sessionId, ...extra], sessionId };
      }
      case 'codex':
        if (req.mode.kind === 'resume') return { cmd: 'codex', args: ['resume', req.mode.sessionId, ...extra], sessionId: req.mode.sessionId };
        if (req.mode.kind === 'fork') return { cmd: 'codex', args: ['fork', req.mode.sessionId, ...extra], sessionId: null };
        return { cmd: 'codex', args: extra, sessionId: null };
      default:
        return { cmd: String(req.agent), args: extra, sessionId: null };
    }
  }
}

function checkMode(info: AgentInfo, mode: LaunchMode): void {
  if (mode.kind === 'resume' && !info.capabilities.resume) fail('unsupported', `${info.label} cannot resume a session`);
  if (mode.kind === 'fork' && !info.capabilities.fork) fail('unsupported', `${info.label} cannot fork a session`);
}
