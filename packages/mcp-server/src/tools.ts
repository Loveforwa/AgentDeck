// MCP 工具：白板里的 agent 用它们开终端、开工作区、开网页、看和指挥别的终端。
// 只靠注入的服务（contracts 的类型）工作，不 import 别的服务包。工具名、参数名、返回的文字都是英文。

import { AgentDeckError, isAgentDeckErrorData } from '@agentdeck/contracts';
import type {
  AbsPath,
  AgentKind,
  AgentService,
  BoardEvent,
  BoardStore,
  BrowserWindowData,
  OpenWindowRequest,
  ProjectId,
  ProjectService,
  StatusService,
  StatusSnapshot,
  TerminalHost,
  TerminalId,
  TerminalWindowData,
  WindowGroupMemberRequest,
  WindowId,
  Workspace,
  WorkspaceId,
  WorkspaceService,
} from '@agentdeck/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
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
  /**
   * 保存的白板（list_windows、focus_window 用）。白板改动后半秒才保存，所以刚开的窗口可能还不在里面。
   * 没有时 list_windows 返回错误。
   */
  board?: Pick<BoardStore, 'load'>;
  /**
   * 问用户一句话（open_terminals 一次超过 MAX_TERMINALS_WITHOUT_CONFIRM 个时）。组装时接系统对话框。
   * 返回 true 表示同意。没有时超过上限一律拒绝。
   */
  confirm?: (req: { title: string; body: string; confirm: string }) => Promise<boolean>;
  /** notify 工具发了一条通知（白板那边由 board.notify 处理）。组装时用来在应用不在前台时发系统通知。 */
  onNotify?: (n: { terminalId: TerminalId | null; message: string }) => void;
}

/** 这次调用来自哪个终端。不是从 AgentDeck 的终端里调的时为 null。 */
export interface McpCaller {
  terminalId: TerminalId | null;
}

const MAX_READ_LINES = 500;
const DEFAULT_READ_LINES = 60;
/** 启动 agent 时给 tmux 的初始大小；窗口 attach 后按真实大小再调。 */
const DEFAULT_TERM_SIZE = { cols: 100, rows: 30 };
/** open_terminals 一次最多开几个不用问用户（需求「12 · MVP v3」N1）。 */
export const MAX_TERMINALS_WITHOUT_CONFIRM = 6;
/** open_terminals 一次最多开几个（问了用户也不能更多）。 */
export const MAX_TERMINALS_PER_CALL = 16;
const MAX_NOTIFY_CHARS = 300;

/**
 * MCP 的 initialize 里给 agent 的说明（claude 会放进系统提示）：什么时候该用这些工具。
 * 需求里“自动装载一个 AgentDeck skill”先用它代替，不往用户配置里写 skill。
 */
export const SERVER_INSTRUCTIONS = [
  'You are running inside AgentDeck, a desktop board where the user watches terminals (agents and shells) and browser windows side by side.',
  'Use these tools to put your work where the user can see it:',
  '- When you split work into parallel subagents that should be visible, use open_terminals (one terminal per subagent, with a prompt each) instead of hidden background tasks; they appear as a group next to you.',
  '- When you start a dev server or produce an HTML page the user should look at, open it with open_browser; it appears next to your terminal.',
  '- Use notify for a short "done" or "needs your review" message, and focus_window to show the user a specific window.',
  '- list_windows and list_terminals show what is on the board; read_terminal and send_to_terminal follow up on other terminals.',
  '- create_workspace is for work on a separate git branch.',
].join('\n');

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
        'Open a web page in a browser window on the board, next to your own terminal: e.g. the dev server you just started (http://localhost:5173) or a local HTML file. Only http(s) URLs and local files. If a window already shows the same origin, it navigates there and reloads instead of opening another one. Defaults to your own workspace.',
      inputSchema: {
        url: z.string().min(1).describe('http(s) URL (e.g. "http://localhost:3000"), a file:// URL, or an absolute path to a local file.'),
        workspace_id: z.string().nullable().optional().describe('Workspace frame to open it in. Omit for your own; null for loose.'),
      },
    },
    ({ url, workspace_id }) =>
      run(async () => {
        const target = browserTarget(url);
        const ws = await ctx.resolveWorkspace(workspace_id);
        const data: BrowserWindowData = {
          url: target,
          mode: 'frame',
          reloadToken: Date.now(),
          openedBy: caller.terminalId ? { terminalId: caller.terminalId, label: 'agent' } : null,
        };
        const reuseKey = originOf(target);
        deps.emit({
          type: 'board.open-window',
          request: { type: 'browser', data, workspaceId: ws?.id ?? null, ...(reuseKey ? { reuseKey } : {}) },
          highlight: true,
          nearTerminal: caller.terminalId,
        });
        return { opened: target, workspaceId: ws?.id ?? null };
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

  server.registerTool(
    'open_terminals',
    {
      title: 'Open terminals',
      description: `Open several terminals at once, e.g. one per subagent when you split work, and start an agent in each. They appear on the board as a group next to your own terminal, in your workspace (same folder and branch), so the user can watch them. Give "prompts" to hand each one its task. Up to ${MAX_TERMINALS_WITHOUT_CONFIRM} without asking; more asks the user first. Follow up with list_terminals, read_terminal and send_to_terminal. To work on separate branches, use create_workspace instead.`,
      inputSchema: {
        count: z.number().int().min(1).max(MAX_TERMINALS_PER_CALL).describe('How many terminals to open.'),
        agent: z.string().default('claude').describe('Agent id for all of them, e.g. "claude", "codex", "shell".'),
        prompts: z
          .array(z.string())
          .optional()
          .describe('First message for each terminal, in order (prompts[0] goes to the first one). Fewer than count leaves the rest without one.'),
        labels: z.array(z.string().max(40)).optional().describe('Short names shown on the board, in order, e.g. ["api", "ui", "tests"].'),
        workspace_id: z.string().nullable().optional().describe('Workspace to open them in. Omit for your own; null for loose terminals.'),
      },
    },
    ({ count, agent, prompts, labels, workspace_id }) =>
      run(async () => {
        if (prompts && prompts.length > count) throw invalid(`Got ${prompts.length} prompts for ${count} terminals`);
        if (labels && labels.length > count) throw invalid(`Got ${labels.length} labels for ${count} terminals`);
        const ws = await ctx.resolveWorkspace(workspace_id);
        if (count > MAX_TERMINALS_WITHOUT_CONFIRM) {
          if (!deps.confirm) {
            throw invalid(
              `Opening more than ${MAX_TERMINALS_WITHOUT_CONFIRM} terminals at once needs the user’s confirmation, which isn’t available. Open at most ${MAX_TERMINALS_WITHOUT_CONFIRM}.`,
            );
          }
          const ok = await deps.confirm({
            title: `Open ${count} terminals?`,
            body: `An agent wants to open ${count} ${agent} terminals${ws ? ` in ${ws.name}` : ''} at once.`,
            confirm: `Open ${count}`,
          });
          if (!ok) throw new AgentDeckError({ code: 'cancelled', message: `The user declined opening ${count} terminals` });
        }
        // 一个一个开（tmux 会话、agent 的启动准备都不适合并发）；中途失败时已经开了的照样放上白板。
        const members: WindowGroupMemberRequest[] = [];
        const opened: { terminalId: TerminalId; label: string | null }[] = [];
        let failure: string | null = null;
        for (let i = 0; i < count; i++) {
          const prompt = prompts?.[i];
          const label = labels?.[i]?.trim() || null;
          try {
            const t = await ctx.launch({ agent, workspace: ws, ...(prompt ? { prompt } : {}) });
            members.push({ request: t.request, label });
            opened.push({ terminalId: t.terminalId, label });
          } catch (e) {
            failure = errorText(e);
            break;
          }
        }
        if (members.length > 0) deps.emit({ type: 'board.open-group', lead: caller.terminalId, members, highlight: true });
        if (opened.length === 0) throw new Error(failure ?? 'No terminals opened');
        return {
          workspaceId: ws?.id ?? null,
          lead: caller.terminalId,
          terminals: opened,
          ...(failure ? { error: `Stopped after ${opened.length} of ${count}: ${failure}` } : {}),
        };
      }),
  );

  server.registerTool(
    'list_windows',
    {
      title: 'List windows',
      description:
        'List the windows on the AgentDeck board (terminals and browser windows) with their workspace, status, conversation topic (the title the agent set) and group (terminals opened together with open_terminals). Your own terminal is marked with "self": true. Windows opened in the last second may be missing.',
      inputSchema: {
        workspace_id: z.string().nullable().optional().describe('Only windows in this workspace; null for loose windows.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ workspace_id }) =>
      run(async () => {
        if (!deps.board) throw new AgentDeckError({ code: 'unsupported', message: 'The board isn’t available' });
        const [board, terminals, statuses] = await Promise.all([deps.board.load(), deps.terminals.list(), deps.status.snapshot()]);
        const infoById = new Map(terminals.map((t) => [t.id, t]));
        const statusById = new Map(statuses.map((s) => [s.terminalId, s]));
        return {
          windows: board.windows
            .filter((w) => workspace_id === undefined || w.workspaceId === workspace_id)
            .map((w) => {
              const term = w.type === 'terminal' ? (w.data as Partial<TerminalWindowData>) : null;
              const tid = term?.terminalId ?? null;
              const info = tid ? infoById.get(tid) : undefined;
              const st = tid ? statusById.get(tid) : undefined;
              const url = w.type === 'browser' ? ((w.data as Partial<BrowserWindowData>).url ?? null) : null;
              return {
                id: w.id,
                type: w.type,
                title: w.title ?? defaultTitle(w.type, term?.agent ?? null, url),
                workspaceId: w.workspaceId,
                ...(term
                  ? {
                      terminalId: tid,
                      agent: term.agent ?? null,
                      status: st?.status ?? (info ? (info.alive ? 'running' : 'exited') : null),
                      waitingFor: st?.pending ? { kind: st.pending.kind, summary: st.pending.summary } : null,
                      topic: info?.title ?? null,
                    }
                  : {}),
                ...(url !== null ? { url } : {}),
                group: w.group ? { id: w.group.id, role: w.group.role, label: w.group.label ?? null } : null,
                self: tid !== null && tid === caller.terminalId,
              };
            }),
        };
      }),
  );

  server.registerTool(
    'focus_window',
    {
      title: 'Focus window',
      description:
        'Bring a window into view on the board and focus it, e.g. the browser window showing your result, or a terminal that needs the user. If the user is typing somewhere, it only flashes the window instead of taking focus. Give window_id (from list_windows) or terminal_id.',
      inputSchema: {
        window_id: z.string().optional().describe('Window id from list_windows.'),
        terminal_id: z.string().optional().describe('Terminal id from list_terminals or open_terminals.'),
      },
    },
    ({ window_id, terminal_id }) =>
      run(async () => {
        if ((window_id === undefined) === (terminal_id === undefined)) throw invalid('Pass either window_id or terminal_id');
        if (terminal_id !== undefined) {
          const id = terminal_id as TerminalId;
          if (!(await deps.terminals.list()).some((t) => t.id === id)) {
            throw new AgentDeckError({ code: 'not-found', message: `Terminal not found: ${terminal_id}` });
          }
          deps.emit({ type: 'board.focus-window', target: { terminalId: id } });
          return { requested: true, terminalId: id };
        }
        const id = window_id as WindowId;
        if (deps.board && !(await deps.board.load()).windows.some((w) => w.id === id)) {
          throw new AgentDeckError({ code: 'not-found', message: `Window not found: ${window_id}` });
        }
        deps.emit({ type: 'board.focus-window', target: { windowId: id } });
        return { requested: true, windowId: id };
      }),
  );

  server.registerTool(
    'notify',
    {
      title: 'Notify',
      description:
        'Tell the user something short without interrupting them, e.g. "Tests passed" or "Ready for review". Your window flashes and a notice shows on the board (only the flash while the user is typing); a system notification when AgentDeck is in the background. Doesn’t take focus.',
      inputSchema: {
        message: z.string().min(1).max(MAX_NOTIFY_CHARS).describe('One short sentence.'),
      },
    },
    ({ message }) =>
      run(async () => {
        const text = message.replace(/\s+/g, ' ').trim();
        if (!text) throw invalid('Empty message');
        deps.emit({ type: 'board.notify', from: caller.terminalId, message: text });
        deps.onNotify?.({ terminalId: caller.terminalId, message: text });
        return { notified: true };
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
  async startTerminal(opts: LaunchOptions & { highlight?: boolean }): Promise<TerminalId> {
    const { terminalId, request } = await this.launch(opts);
    this.deps.emit({ type: 'board.open-window', request, highlight: opts.highlight ?? true });
    return terminalId;
  }

  /** 只 agents.start，返回给白板的开窗请求（open_terminals 一组一起发）。 */
  async launch(opts: LaunchOptions): Promise<{ terminalId: TerminalId; request: OpenWindowRequest<TerminalWindowData> }> {
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
    return { terminalId: res.terminalId, request: { type: 'terminal', data, workspaceId } };
  }
}

interface LaunchOptions {
  agent: AgentKind;
  workspace: Workspace | null;
  prompt?: string;
  command?: string;
  cwd?: AbsPath;
}

function invalid(message: string): AgentDeckError {
  return new AgentDeckError({ code: 'invalid-argument', message });
}

function errorText(e: unknown): string {
  return e instanceof Error || isAgentDeckErrorData(e) ? e.message : String(e);
}

/** 用户没 Rename 时的标题，和白板标题栏一样：终端是 agent 名，网页是主机名（本地文件是文件名）。 */
function defaultTitle(type: string, agent: AgentKind | null, url: string | null): string {
  if (type === 'terminal') return agent ?? 'terminal';
  if (type === 'browser' && url) {
    if (url.startsWith('/')) return url.split('/').filter(Boolean).pop() ?? url;
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  }
  return type;
}

/** 不带协议的本机地址（agent 常写 “localhost:3000”），补上 http://。 */
const BARE_LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i;

/**
 * open_browser 能开的地址（需求「12 · MVP v3」N1：只允许 http(s) 和本地文件）：
 * - http(s) URL，原样（URL 规范化后）；不带协议的 localhost:3000 补上 http://；
 * - 本地文件：绝对路径，或 file:// URL（换成绝对路径，BrowserWindowData.url 的约定，打开时再经 BrowserService.prepare）。
 * 其他（javascript:、data:、相对路径、~/……）一律拒绝。
 */
export function browserTarget(raw: string): string {
  const text = raw.trim();
  const reject = () => invalid(`Only http(s) URLs and local files can be opened: ${raw}`);
  if (text.startsWith('/')) {
    if (text.startsWith('//')) throw reject();
    return text;
  }
  const candidate = BARE_LOCAL.test(text) ? `http://${text}` : text;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    throw reject();
  }
  if (u.protocol === 'file:') {
    if (u.host && u.host !== 'localhost') throw reject();
    try {
      return fileURLToPath(u);
    } catch {
      throw reject();
    }
  }
  if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) return u.href;
  throw reject();
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
