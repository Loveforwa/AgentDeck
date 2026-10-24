// AGENTDECK_DEMO=1：在（dev）数据目录里把本仓库加成项目、建主目录工作区，在框里开一个 Shell 和一个 claude。
// Shell 里只跑没有副作用的 git status / git log；claude 只启动，不发任何消息。
// 已经有这个框和终端时（第二次运行、重开应用）什么都不做，只把视口对准框。
// 截图模式：白板准备好后告诉主进程（看得见几个终端），主进程等它们都有输出再截图。

import type { AgentDeckApi, Project, TerminalWindowData, WindowId, WorkspaceId } from '@agentdeck/contracts';
import type { BoardController } from '@agentdeck/ui-canvas';

const SHELL_COMMANDS = ['git status', 'git --no-pager log --oneline -5'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureProject(api: AgentDeckApi, repoPath: string): Promise<Project> {
  const probe = await api.projects.probe(repoPath);
  if (probe.kind === 'already-added') return probe.project;
  const folder = probe.kind === 'git' ? probe.repoRoot : probe.folder;
  const [project] = await api.projects.add({ folder, as: probe.kind === 'multi-repo' ? 'multi-repo' : probe.kind });
  if (!project) throw new Error(`Couldn’t add ${repoPath}`);
  return project;
}

function terminalsIn(controller: BoardController, ws: WorkspaceId) {
  return controller.state.windows.filter((w) => w.type === 'terminal' && w.workspaceId === ws);
}

export async function runDemo(controller: BoardController, api: AgentDeckApi, repoPath: string): Promise<void> {
  const project = await ensureProject(api, repoPath);
  const existing = Object.values(controller.state.workspaces).find((w) => w.projectId === project.id && w.mode === 'main-folder');
  let wsId: WorkspaceId | null = existing && controller.frameOf(existing.id) ? existing.id : null;
  if (!wsId) {
    if (existing) {
      console.warn('[demo] the main-folder workspace exists but is not on the board; skipping');
      return;
    }
    wsId = await controller.createWorkspace({ projectId: project.id, mode: 'main-folder' }, null);
    if (!wsId) throw new Error('Couldn’t create the main-folder workspace');
  }

  if (terminalsIn(controller, wsId).length === 0) {
    const shellWin = await controller.newTerminal({ agent: 'shell', workspaceId: wsId });
    // 终端窗口把 500ms 内的 terminals.list() 合成一次：紧接着建的第二个终端会在旧的列表里找不到自己，
    // 显示 “Previous session ended”（IS-07），所以隔开一点
    await sleep(700);
    await controller.newTerminal({ agent: 'claude', workspaceId: wsId, nextTo: shellWin });
    if (shellWin) void typeIntoShell(controller, api, shellWin);
    if (shellWin) controller.focusWindow(shellWin);
  } else {
    const first = terminalsIn(controller, wsId)[0];
    if (first) controller.focusWindow(first.id);
  }
  controller.fitFrame(wsId);
}

async function typeIntoShell(controller: BoardController, api: AgentDeckApi, win: WindowId): Promise<void> {
  const data = controller.windowById(win)?.data as TerminalWindowData | undefined;
  const id = data?.terminalId;
  if (!id) return;
  // 等登录 shell 画出提示符（读 .zshrc 要一会儿）；提前发的键 tmux 也会排进 pty，只是画面会乱一点
  await sleep(1500);
  for (const cmd of SHELL_COMMANDS) {
    await api.terminals.sendKeys(id, [cmd, 'Enter']);
    await sleep(300);
  }
}

/** 截图模式：等白板画完、视口动画结束，再报看得见的终端数。 */
export function reportBoardReady(controller: BoardController): void {
  setTimeout(() => {
    const s = controller.state;
    const visible = s.windows.filter((w) => w.type === 'terminal' && controller.isVisible(w.rect) && !controller.isSummary(w)).length;
    window.agentdeckDesktop?.boardReady({ visibleTerminals: visible });
  }, 800);
}
