// 把本包的几块接在一起，给组装阶段（apps/desktop 主进程）一个入口：
//   AgentService ─onStarted→ StatusMachine.track
//   HookServer ─decide→ ApprovalServiceImpl.decide（Auto-approve 的钩子回答）─onHook→ StatusMachine.onHook
//   StatusMachine 的事件 → ApprovalServiceImpl（按键批准、needs-you）
//   TerminalHost 的事件 → onTerminalEvent；IPC 层的 terminals.write / sendKeys → noteInput
// 组装时把 agents / status / approvals 挂到 IPC 上，emit 接到事件通道。

import type { AbsPath, AgentKind, McpEndpoint, StatusEvent, TerminalEvent, TerminalHost, TerminalId } from '@agentdeck/contracts';
import { createDefaultAdapters } from './adapters/index.ts';
import type { AgentAdapterExt } from './adapters/types.ts';
import { AgentServiceImpl } from './agent-service.ts';
import type { AgentServiceOptions, StartedAgent } from './agent-service.ts';
import type { EnvSource } from './env.ts';
import { conversationCheckFromEnv, conversationExists } from './fork.ts';
import type { UsageRoots } from './usage/locate.ts';
import { hookHint } from './hook-payload.ts';
import type { HookServerOptions, ReceivedHook } from './hook-server.ts';
import { HookServer } from './hook-server.ts';
import { ApprovalServiceImpl } from './status/approval.ts';
import type { ApprovalRecordStore, ApprovalTiming } from './status/approval.ts';
import { StatusMachine } from './status/machine.ts';

export interface AgentRuntimeOptions {
  /** 登录 shell 的环境。 */
  env: EnvSource;
  /** create 给 AgentService；sendKeys、lastLines 给 ApprovalService（批准按键、看屏幕），不给时批准一律失败（测试里常不给）。 */
  terminals: Pick<TerminalHost, 'create'> & Partial<Pick<TerminalHost, 'sendKeys' | 'lastLines'>>;
  /** agentdeck-notify 的绝对路径。 */
  notifyCommand: AbsPath;
  /** agentdeck-pi-extension.mjs 的绝对路径（pi、omp 用 -e 加载它拿状态）。不给时它们没有钩子。 */
  agentExtension?: AbsPath;
  /** 写好 mcpPluginFiles() 的目录（N1：omp 用 --plugin-dir 挂 AgentDeck 的 MCP）。不给时 omp 不挂。 */
  mcpPluginDir?: AbsPath;
  emit: (event: StatusEvent) => void;
  /** Settings › Approvals › destructivePatterns。 */
  destructivePatterns: () => readonly string[];
  /** Settings › Agents › extraArgs。 */
  extraArgs?: (agent: AgentKind) => string[];
  /** AgentDeck 的 MCP 服务（M1），见 AgentServiceOptions.mcp。 */
  mcp?: () => McpEndpoint | null;
  /** CR15：每个终端的钥匙，见 AgentServiceOptions.terminalKey。 */
  terminalKey?: AgentServiceOptions['terminalKey'];
  /** CR15：agentdeck 命令的目录，见 AgentServiceOptions.binDir。 */
  binDir?: AbsPath;
  /** N9：这次启动带哪些 skill 和 MCP，见 AgentServiceOptions.skills。 */
  skills?: AgentServiceOptions['skills'];
  /** 一个 agent 终端起来之后（状态机 track 之后）再告诉组装方，例如记下它带了哪些 skill（N9）。 */
  onStarted?: (started: StartedAgent) => void;
  /** 默认 ~/.agentdeck/run/hooks.sock。 */
  socketPath?: string;
  /** 默认 createDefaultAdapters。 */
  adapters?: AgentAdapterExt[];
  /** 覆盖 Auto-approve 的钩子回答（测试用）。默认 ApprovalServiceImpl.decide。 */
  decide?: HookServerOptions['decide'];
  /** 批准记录写到哪里（packages/store 的 approvals）。不给时只在内存里。 */
  approvalRecords?: ApprovalRecordStore;
  approvalTiming?: ApprovalTiming;
  /**
   * 每条钩子先给它看（用量模块：pi / omp 扩展报的上下文、claude 的 transcript_path）。
   * 返回 true 表示这条只是给它的（USAGE_HOOK），不交给状态机。
   */
  tapHook?: (hook: ReceivedHook) => boolean;
  /**
   * X4：fork 前到哪里找原来的对话（只读）。不给时按登录 shell 环境的 HOME、CLAUDE_CONFIG_DIR 等推（defaultUsageRoots）；
   * null 表示不查，直接启动。
   */
  sessionRoots?: UsageRoots | null;
  now?: () => Date;
}

export function createAgentRuntime(opts: AgentRuntimeOptions) {
  const adapters =
    opts.adapters ??
    createDefaultAdapters({
      env: opts.env,
      ...(opts.agentExtension ? { agentExtension: opts.agentExtension } : {}),
      ...(opts.mcpPluginDir ? { mcpPluginDir: opts.mcpPluginDir } : {}),
    });
  // 状态机的事件先交给界面，再给 ApprovalService（按键批准要看状态有没有离开 needs-approval）
  let approvals: ApprovalServiceImpl | null = null;
  const status = new StatusMachine({
    emit: (e) => {
      opts.emit(e);
      approvals?.onStatusEvent(e);
    },
    destructivePatterns: opts.destructivePatterns,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const agents = new AgentServiceImpl({
    adapters,
    terminals: opts.terminals,
    env: opts.env,
    notifyCommand: opts.notifyCommand,
    ...(opts.extraArgs ? { extraArgs: opts.extraArgs } : {}),
    ...(opts.mcp ? { mcp: opts.mcp } : {}),
    ...(opts.terminalKey ? { terminalKey: opts.terminalKey } : {}),
    ...(opts.binDir ? { binDir: opts.binDir } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
    ...(opts.sessionRoots === null
      ? {}
      : { conversationExists: opts.sessionRoots ? conversationExists(opts.sessionRoots) : conversationCheckFromEnv(opts.env) }),
    onStarted: (s) => {
      status.track(s.terminalId, { agent: s.agent, workspaceId: s.workspaceId, hooks: s.hooks, sessionId: s.sessionId });
      opts.onStarted?.(s);
    },
  });
  const approvalService = new ApprovalServiceImpl({
    status,
    terminals: {
      sendKeys: (id, keys) => (opts.terminals.sendKeys ? opts.terminals.sendKeys(id, keys) : Promise.reject(new Error('sendKeys not available'))),
      lastLines: (id, n) => (opts.terminals.lastLines ? opts.terminals.lastLines(id, n) : Promise.resolve([])),
    },
    approveKeys: (agent) => agents.adapter(agent)?.approveOnceKeys ?? null,
    destructivePatterns: opts.destructivePatterns,
    emit: opts.emit,
    ...(opts.approvalRecords ? { records: opts.approvalRecords } : {}),
    ...(opts.approvalTiming ? { timing: opts.approvalTiming } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  approvals = approvalService;
  const hookServer = new HookServer({
    ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
    adapterFor: (agent) => agents.adapter(agent),
    onHook: (h) => {
      try {
        if (opts.tapHook?.(h) === true) return;
      } catch {
        // 用量模块出错不影响状态
      }
      // Auto-approve 已经用钩子放行：agent 不会显示确认框，终端也不进 needs-approval（书签上记一次）
      if (h.decision === 'allow' && h.event?.type === 'permission-request') {
        approvalService.noteAutoAllowed(h);
        status.onHook(h.terminalId, null);
        return;
      }
      status.onHook(h.terminalId, h.event, hookHint(h.hookName, h.envelope.payload));
    },
    decide: opts.decide ?? ((h) => approvalService.decide(h)),
  });
  return {
    agents,
    status,
    approvals: approvalService,
    hookServer,
    onTerminalEvent: (event: TerminalEvent) => status.onTerminalEvent(event),
    noteInput: (terminalId: TerminalId) => status.noteInput(terminalId),
    start: () => hookServer.start(),
    close: () => hookServer.close(),
  };
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
