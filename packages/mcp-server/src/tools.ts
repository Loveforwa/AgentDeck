// MCP 工具：白板里的 agent 用它们开终端、开工作区、开网页、看和指挥别的终端。
// 只靠注入的服务（contracts 的类型）工作，不 import 别的服务包。工具名、参数名、返回的文字都是英文。

import { AgentDeckError, isAgentDeckErrorData } from '@agentdeck/contracts';
import type {
  AbsPath,
  AgentKind,
  AgentService,
  BoardEvent,
  BrowserWindowData,
  ProjectId,
  ProjectService,
  StatusService,
  StatusSnapshot,
  TerminalHost,
  TerminalId,
  TerminalWindowData,
  Workspace,
  WorkspaceId,
  WorkspaceService,
} from '@agentdeck/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** 工具用到的服务，组装时从主进程的注册表拿。 */
export interface McpToolDeps {
  projects: Pick<ProjectService, 'list'>;
  workspaces: Pick<WorkspaceService, 'list' | 'create'>;
  agents: Pick<AgentService, 'list' | 'start'>;
  terminals: Pick<TerminalHost, 'list' | 'lastLines' | 'sendKeys'>;
  status: Pick<StatusService, 'snapshot'>;
  /** 让白板把建好的框、窗口放上去（发给所有界面窗口）。 */
  emit: (event: BoardEvent) => void;
  /** 散放终端的目录。 */
  homeDir: AbsPath;
  /**
   * 终端在哪个工作区（组装时接 StatusMachine.get(id)?.workspaceId）。返回 undefined 表示不知道：
   * 退回 status.snapshot 的 workspaceId，再退回按终端当前目录找工作区。
   */
  workspaceOf?: (terminalId: TerminalId) => WorkspaceId | null | undefined;
  /** 往终端发了输入之后（状态机兜底用，同 IPC 层的 terminals.sendKeys）。 */
  onInput?: (terminalId: TerminalId) => void;
  /** 两次 sendKeys 之间等多久（毫秒）。文字和回车分开发，agent 才不会把回车当成粘贴里的换行。默认 150。 */
  submitDelayMs?: number;
}

/** 这次调用来自哪个终端。不是从 AgentDeck 的终端里调的时为 null。 */
export interface McpCaller {
  terminalId: TerminalId | null;
}

const MAX_READ_LINES = 500;
const DEFAULT_READ_LINES = 60;
/** 启动 agent 时给 tmux 的初始大小；窗口 attach 后按真实大小再调。 */
const DEFAULT_TERM_SIZE = { cols: 100, rows: 30 };

export function registerTools(server: McpServer, deps: McpToolDeps, caller: McpCaller): void {
  const ctx = new ToolContext(deps, caller);

  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description:
        'List the projects and workspaces on the AgentDeck board. A workspace is a folder (usually a git worktree on its own branch) shown as a frame on the board. The workspace you are running in is marked with "current": true.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const [projects, workspaces, me] = await Promise.all([deps.projects.list(), deps.workspaces.list(), ctx.callerWorkspaceId()]);
        return {
          projects: projects.map((p) => ({ id: p.id, name: p.name, path: p.path, kind: p.kind })),
          workspaces: workspaces.map((w) => ({
            id: w.id,
            projectId: w.projectId,
            name: w.name,
            branch: w.branch,
            path: w.path,
            missing: w.missing,
            current: w.id === me,
          })),
        };
      }),
  );

  server.registerTool(
    'list_terminals',
    {
      title: 'List terminals',
      description:
        'List the terminals AgentDeck is running (agents and shells) with their status: starting, running, needs-approval, needs-reply, idle, exited or error. Your own terminal is marked with "self": true.',
      inputSchema: {
        workspace_id: z.string().optional().describe('Only terminals in this workspace.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ workspace_id }) =>
      run(async () => {
        const [terminals, statuses, workspaces] = await Promise.all([deps.terminals.list(), deps.status.snapshot(), deps.workspaces.list()]);
        const byId = new Map(statuses.map((s) => [s.terminalId, s]));
        return {
          terminals: terminals
            .map((t) => ({ t, s: byId.get(t.id), ws: ctx.workspaceIdOf(t.id, byId.get(t.id), t.cwd, workspaces) }))
            .filter(({ ws }) => workspace_id === undefined || ws === workspace_id)
            .map(({ t, s, ws }) => ({
              id: t.id,
              workspaceId: ws,
              status: s?.status ?? (t.alive ? 'running' : 'exited'),
              command: t.command,
              cwd: t.cwd,
              alive: t.alive,
              exitCode: t.exitCode,
              waitingFor: s?.pending ? { kind: s.pending.kind, summary: s.pending.summary } : null,
              self: t.id === caller.terminalId,
            })),
        };
      }),
  );

  server.registerTool(
    'open_terminal',
    {
      title: 'Open terminal',
      description:
        'Open a new terminal window on the board and start an agent (claude, codex) or a shell in it. Defaults to your own workspace. Give "prompt" to hand the new agent its first message, so it starts working right away.',
      inputSchema: {
        agent: z.string().default('claude').describe('Agent id from AgentDeck, e.g. "claude", "codex", "shell".'),
        workspace_id: z
          .string()
          .nullable()
          .optional()
          .describe('Workspace to open it in. Omit for your own workspace; null for a loose terminal in the home folder.'),
        prompt: z.string().optional().describe('First message for the agent. Ignored for shells.'),
        command: z.string().optional().describe('For "shell": a command to run, e.g. "pnpm dev".'),
      },
    },
    ({ agent, workspace_id, prompt, command }) =>
      run(async () => {
        const ws = await ctx.resolveWorkspace(workspace_id);
        const t = await ctx.startTerminal({ agent, workspace: ws, ...(prompt ? { prompt } : {}), ...(command ? { command } : {}) });
        return { terminalId: t, workspaceId: ws?.id ?? null };
      }),
  );

  server.registerTool(
    'create_workspace',
    {
      title: 'Create workspace',
      description:
        'Create a new git worktree on a new branch, put it on the board as a frame, and start an agent in it. Use this to run several agents in parallel on separate branches. Defaults to your own project; the new branch starts from the project base branch unless "from" is given.',
      inputSchema: {
        branch: z.string().min(1).describe('Name of the new branch, e.g. "feat/login-page".'),
        from: z.string().optional().describe('Branch to start from. Defaults to the base branch.'),
        existing_branch: z.boolean().default(false).describe('Check out an existing branch instead of creating one.'),
        project_id: z.string().optional().describe('Project to create it in. Defaults to the project of your workspace.'),
        agent: z.string().default('claude').describe('Agent to start in the new workspace, or "none".'),
        prompt: z.string().optional().describe('First message for that agent.'),
      },
    },
    ({ branch, from, existing_branch, project_id, agent, prompt }) =>
      run(async () => {
        const projectId = await ctx.resolveProject(project_id);
        const { workspace, setup } = await deps.workspaces.create({
          projectId,
          mode: 'worktree',
          branch: existing_branch ? { kind: 'existing', name: branch } : { kind: 'new', name: branch, ...(from ? { from } : {}) },
        });
        deps.emit({ type: 'board.add-frame', workspace });
        // 和白板的 New workspace 一样：有初始化命令就在框里先开一个 Shell 跑它。
        const setupTerminal = setup
          ? await ctx.startTerminal({ agent: 'shell', workspace, command: setup.command, cwd: setup.cwd, highlight: false })
          : null;
        const agentTerminal = agent === 'none' ? null : await ctx.startTerminal({ agent, workspace, ...(prompt ? { prompt } : {}) });
        return {
          workspaceId: workspace.id,
          branch: workspace.branch,
          path: workspace.path,
          terminalId: agentTerminal,
          setupTerminalId: setupTerminal,
          setupCommand: setup?.command ?? null,
        };
      }),
  );

  server.registerTool(
    'open_browser',
    {
      title: 'Open browser',
      description:
        'Open a web page in a browser window on the board, e.g. the dev server you just started (http://localhost:5173) or a local HTML file. Reuses the window already showing the same origin. Defaults to your own workspace.',
      inputSchema: {
        url: z.string().min(1).describe('http(s) URL, or an absolute path to a local file.'),
        workspace_id: z.string().nullable().optional().describe('Workspace frame to open it in. Omit for your own; null for loose.'),
      },
    },
    ({ url, workspace_id }) =>
      run(async () => {
        const ws = await ctx.resolveWorkspace(workspace_id);
        const data: BrowserWindowData = {
          url,
          mode: 'frame',
          reloadToken: Date.now(),
          openedBy: caller.terminalId ? { terminalId: caller.terminalId, label: 'agent' } : null,
        };
        const reuseKey = originOf(url);
        deps.emit({
          type: 'board.open-window',
          request: { type: 'browser', data, workspaceId: ws?.id ?? null, ...(reuseKey ? { reuseKey } : {}) },
          highlight: true,
        });
        return { opened: url, workspaceId: ws?.id ?? null };
      }),
  );

  server.registerTool(
    'read_terminal',
    {
      title: 'Read terminal',
      description: 'Read the last lines shown in another terminal, e.g. to check what another agent did or why a dev server failed.',
      inputSchema: {
        terminal_id: z.string().describe('Terminal id from list_terminals.'),
        lines: z.number().int().min(1).max(MAX_READ_LINES).default(DEFAULT_READ_LINES),
      },
      annotations: { readOnlyHint: true },
    },
    ({ terminal_id, lines }) =>
      run(async () => {
        const id = terminal_id as TerminalId;
        const [text, status] = await Promise.all([deps.terminals.lastLines(id, lines), ctx.statusOf(id)]);
        return { terminalId: id, status: status?.status ?? null, lines: trimTrailingBlank(text).join('\n') };
      }),
  );

  server.registerTool(
    'send_to_terminal',
    {
      title: 'Send to terminal',
      description:
        'Type text into another terminal, as if the user typed it: a message for another agent, or a command for a shell. Presses Enter afterwards unless "submit" is false. Line breaks are sent as spaces. Cannot send to your own terminal.',
      inputSchema: {
        terminal_id: z.string().describe('Terminal id from list_terminals.'),
        text: z.string().min(1),
        submit: z.boolean().default(true).describe('Press Enter after the text.'),
      },
    },
    ({ terminal_id, text, submit }) =>
      run(async () => {
        const id = terminal_id as TerminalId;
        if (id === caller.terminalId) throw new AgentDeckError({ code: 'invalid-argument', message: 'Can’t send to your own terminal' });
        await deps.terminals.sendKeys(id, literalKeys(text));
        if (submit) {
          await sleep(deps.submitDelayMs ?? 150);
          await deps.terminals.sendKeys(id, ['Enter']);
        }
        deps.onInput?.(id);
        return { sent: true, terminalId: id };
      }),
  );
}

class ToolContext {
  constructor(
    private readonly deps: McpToolDeps,
    private readonly caller: McpCaller,
  ) {}

  async statusOf(id: TerminalId): Promise<StatusSnapshot | undefined> {
    return (await this.deps.status.snapshot()).find((s) => s.terminalId === id);
  }

  async callerWorkspaceId(): Promise<WorkspaceId | null> {
    const id = this.caller.terminalId;
    if (!id) return null;
    const known = this.deps.workspaceOf?.(id);
    if (known !== undefined) return known;
    const [status, terminals, workspaces] = await Promise.all([this.statusOf(id), this.deps.terminals.list(), this.deps.workspaces.list()]);
    return this.workspaceIdOf(id, status, terminals.find((t) => t.id === id)?.cwd ?? null, workspaces);
  }

  /** 见 McpToolDeps.workspaceOf。按目录找时取路径最长的那个（worktree 可能在主目录里面）。 */
  workspaceIdOf(id: TerminalId, status: StatusSnapshot | undefined, cwd: AbsPath | null, workspaces: Workspace[]): WorkspaceId | null {
    const fromDeps = this.deps.workspaceOf?.(id);
    if (fromDeps !== undefined) return fromDeps;
    if (status?.workspaceId !== undefined) return status.workspaceId;
    if (!cwd) return null;
    const inside = workspaces.filter((w) => cwd === w.path || cwd.startsWith(w.path.endsWith('/') ? w.path : `${w.path}/`));
    inside.sort((a, b) => b.path.length - a.path.length);
    return inside[0]?.id ?? null;
  }

  /** undefined：调用者所在的工作区（调用者散放或不在 AgentDeck 里时为 null）；null：散放。 */
  async resolveWorkspace(id: string | null | undefined): Promise<Workspace | null> {
    const wanted = id === undefined ? await this.callerWorkspaceId() : id;
    if (wanted === null) return null;
    const ws = (await this.deps.workspaces.list()).find((w) => w.id === wanted);
    if (!ws) throw new AgentDeckError({ code: 'not-found', message: `Workspace not found: ${wanted}` });
    return ws;
  }

  async resolveProject(id: string | undefined): Promise<ProjectId> {
    if (id !== undefined) {
      if (!(await this.deps.projects.list()).some((p) => p.id === id)) {
        throw new AgentDeckError({ code: 'not-found', message: `Project not found: ${id}` });
      }
      return id as ProjectId;
    }
    const ws = await this.resolveWorkspace(undefined);
    if (ws) return ws.projectId;
    const projects = await this.deps.projects.list();
    if (projects.length === 1) return projects[0]!.id;
    throw new AgentDeckError({ code: 'invalid-argument', message: 'Pass project_id: you are not in a workspace (see list_workspaces)' });
  }

  /** agents.start，再让白板把终端窗口放进框里。 */
  async startTerminal(opts: {
    agent: AgentKind;
    workspace: Workspace | null;
    prompt?: string;
    command?: string;
    cwd?: AbsPath;
    highlight?: boolean;
  }): Promise<TerminalId> {
    const cwd = opts.cwd ?? opts.workspace?.path ?? this.deps.homeDir;
    const workspaceId = opts.workspace?.id ?? null;
    const res = await this.deps.agents.start({
      agent: opts.agent,
      cwd,
      workspaceId,
      mode: { kind: 'new' },
      size: DEFAULT_TERM_SIZE,
      ...(opts.command !== undefined ? { command: opts.command } : {}),
      ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
    });
    const data: TerminalWindowData = {
      terminalId: res.terminalId,
      agent: opts.agent,
      cmd: res.cmd,
      args: res.args,
      cwd,
      sessionId: res.sessionId,
      startCommand: opts.command ?? null,
    };
    this.deps.emit({ type: 'board.open-window', request: { type: 'terminal', data, workspaceId }, highlight: opts.highlight ?? true });
    return res.terminalId;
  }
}

/** 工具的返回：成功时是 JSON 文本，失败时 isError 加一句英文。 */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  } catch (e) {
    const message = e instanceof Error || isAgentDeckErrorData(e) ? e.message : String(e);
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

/**
 * 把文字变成 tmux send-keys 的参数，保证按原样打出来：
 * - 换行换成空格（换行会被 agent 当成回车提交）；
 * - 整段恰好是按键名（Enter、C-c、F1……）时 tmux 会当按键发，所以没有空格的文字按单个字符发；
 * - 参数结尾的 `;` 是 tmux 的命令分隔符，会被吞掉（`find … \;` 里的反斜杠也会被吃，tmux 3.6 实测），
 *   所以结尾的分号拆出来，每个单独发 `\;`。
 */
export function literalKeys(text: string): string[] {
  const flat = text.replace(/\r\n|\r|\n/g, ' ');
  if (!/\s/.test(flat)) return [...flat].map((c) => (c === ';' ? '\\;' : c));
  const body = flat.replace(/;+$/, '');
  const semicolons = flat.length - body.length;
  return [...(body ? [body] : []), ...Array<string>(semicolons).fill('\\;')];
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === '') end--;
  return lines.slice(0, end);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
