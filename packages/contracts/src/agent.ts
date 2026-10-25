// agent 接入：每个 agent 一个适配器，加一个 agent 就是加一个文件再注册一行。
// 需求见「5 · 终端窗口」「6 · 终端状态与提醒」。实现：packages/agent-adapters（线 4）。

import type { AbsPath, AgentKind, AgentSessionId, IsoTime, TermSize, TerminalId, WorkspaceId } from './common.ts';
import type { McpEndpoint } from './mcp.ts';

export interface AgentCapabilities {
  /** 有钩子，状态准确（claude、新版 codex）。没有时只能靠 tmux 的输出活动判断运行中和空闲。 */
  hooks: boolean;
  /** 能按会话 id 接回原来的对话。 */
  resume: boolean;
  /** 能把一个对话复制成新会话（claude --fork-session、codex fork）。 */
  fork: boolean;
  /** 有专门向用户提问的工具，能区分“在问你”和“说完了”。 */
  askTool: boolean;
}

export type LaunchMode =
  | { kind: 'new' }
  | { kind: 'resume'; sessionId: AgentSessionId }
  | { kind: 'fork'; sessionId: AgentSessionId };

export interface LaunchContext {
  cwd: AbsPath;
  /** 这个终端将使用的 id（AgentService 先生成，再传给 TerminalHost.create 的 id）。钩子靠 AGENTDECK_TERM 对上。 */
  terminalId: TerminalId;
  /** shell / custom 要运行的命令，例如 'pnpm dev'。 */
  command?: string;
  mode: LaunchMode;
  /** agentdeck-notify 小命令的绝对路径，写进钩子配置。 */
  notifyCommand: AbsPath;
  /** 用户在 Settings › Agents 里加的启动参数。 */
  extraArgs: string[];
  /** 启动后当作第一条消息发给 agent（见 StartAgentRequest.prompt）。只在 mode 为 new 时有意义。 */
  prompt?: string;
  /** AgentDeck 的 MCP 服务（M1）。有值且适配器支持时挂到 agent 上；token 放进 LaunchSpec.env，不进命令行。 */
  mcp?: McpEndpoint;
}

export interface LaunchSpec {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * 这次启动对应的 agent 会话 id。
   * claude 由我们生成并通过 --session-id 传入，所以启动时就知道；codex 要等 session-start 钩子才知道，这里为 null。
   */
  sessionId: AgentSessionId | null;
}

/** 钩子原始负载转换后的统一事件。 */
export type AgentHookEvent =
  | { type: 'session-start'; sessionId: AgentSessionId }
  | { type: 'prompt-submitted' }
  | {
      type: 'permission-request';
      /** 例如 'Bash'、'Edit'。 */
      tool: string | null;
      /** 给人看的一句话，例如 "pnpm test"。 */
      summary: string;
      /** 要运行的命令，用来判断是否有破坏性。 */
      command: string | null;
    }
  | { type: 'question'; summary: string }
  /** 一个工具跑完了（claude 的 PostToolUse）。claude 会并行跑工具，跑完的不一定是还在等批准的那个。 */
  | { type: 'tool-done'; tool: string | null; summary: string }
  | { type: 'turn-end' }
  | { type: 'session-end' };

export interface AgentAdapter {
  id: AgentKind;
  /** 菜单里显示的名字，英文。 */
  label: string;
  /** 默认命令名，例如 'claude'。 */
  command: string;
  detect(): Promise<{ installed: boolean; version: string | null; path: AbsPath | null }>;
  /** 能力可能随版本不同，例如旧版 codex 没有钩子。 */
  capabilities(version: string | null): AgentCapabilities;
  /** 不支持的 mode 要抛 AgentDeckError('unsupported')。 */
  launch(ctx: LaunchContext): LaunchSpec;
  /** 把钩子发来的原始 JSON 转成统一事件；认不出返回 null。 */
  parseHook(hookName: string, payload: unknown): AgentHookEvent | null;
  /** 发给 tmux 的“允许一次”按键，例如 claude ['Enter']、codex ['y']。没有就不支持 Approve all。 */
  approveOnceKeys: string[] | null;
}

/** 给界面用的 agent 信息。 */
export interface AgentInfo {
  id: AgentKind;
  label: string;
  installed: boolean;
  version: string | null;
  capabilities: AgentCapabilities;
  /** 有问题时给 Settings › Agents 显示的一句话（英文），例如钩子被用户关掉、状态退回看输出活动。 */
  warning?: string | null;
}

export interface StartAgentRequest {
  agent: AgentKind;
  cwd: AbsPath;
  workspaceId: WorkspaceId | null;
  mode: LaunchMode;
  /** agent 为 'custom' 或 'shell' 时的命令，例如 'pnpm dev'。 */
  command?: string;
  /** 窗口当前能放下的行列数，原样传给 terminals.create，避免 TUI 先按 80×24 画、attach 后再跳一次。 */
  size?: TermSize;
  /** agent 启动后的第一条消息（claude、codex 作为命令行参数传入）。shell / custom 忽略。 */
  prompt?: string;
  /**
   * X6：只对 shell 有意义（其他 agent 忽略）：shell 起来后在输入行里填好这条命令但不运行，转给 CreateTerminalRequest.prefill。
   * 恢复上次会话时用；不要和 command 一起给（command 会直接运行）。X6 加。
   */
  prefill?: string;
}

export interface StartAgentResult {
  terminalId: TerminalId;
  /** 见 LaunchSpec.sessionId。 */
  sessionId: AgentSessionId | null;
  /** 存进 TerminalWindowData，重启后按同样的命令恢复。 */
  cmd: string;
  args: string[];
}

export interface AgentService {
  /** 已注册的 agent 和安装情况，New terminal ▸ 菜单用。 */
  list(): Promise<AgentInfo[]>;
  /** 重新检测安装情况（Settings 里的 Refresh）。 */
  refresh(): Promise<AgentInfo[]>;
  /**
   * 新开一个 agent 终端：适配器算出启动命令，再调 TerminalHost.create。
   * 新建、恢复会话（resume）、Fork 都走这里。界面不直接调 terminals.create 来开 agent。
   */
  start(req: StartAgentRequest): Promise<StartAgentResult>;
}

// ---- 钩子传输协议 ----
// agent 的钩子运行 `agentdeck-notify <agent> <hookName>`，它从 stdin 读钩子负载，
// 从环境变量 AGENTDECK_TERM 读终端 id，连上 HOOK_SOCKET，发一行 HookEnvelope（JSON + '\n'）。
// 需要回答的钩子（PermissionRequest）会等一行 HookReply，超时 2 秒按 { decision: 'none' } 处理。

/** 相对用户主目录。 */
export const HOOK_SOCKET = '.agentdeck/run/hooks.sock';

export interface HookEnvelope {
  v: 1;
  terminalId: TerminalId;
  agent: AgentKind;
  /** agent 自己的钩子名，例如 'PermissionRequest'、'Stop'。 */
  hookName: string;
  payload: unknown;
  at: IsoTime;
  /** true 表示 notify 在等 HookReply。 */
  expectsReply: boolean;
}

export interface HookReply {
  v: 1;
  /* 只对批准类请求（permission-request）回 allow。提问（claude 的 AskUserQuestion 也走 PermissionRequest 钩子）永远回 none，否则会替用户回答。 */
  /** allow：Auto-approve 打开且不是危险命令时直接允许；none：照常显示 agent 自己的确认。 */
  decision: 'allow' | 'none';
}
