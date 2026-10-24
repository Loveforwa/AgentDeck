// 界面进程能用的全部能力，以及 IPC 的线路约定。
// 界面只通过 window.agentdeck（类型是 AgentDeckApi）调用服务，不直接碰 Electron。
// 实现：apps/desktop 的 preload 和主进程路由（M0 · F3）。

import type { AppEvent, AppService } from './app.ts';
import type { AgentService } from './agent.ts';
import type { BoardEvent, BoardStore } from './board.ts';
import type { BrowserService } from './browser.ts';
import type { Unsubscribe } from './common.ts';
import type { GitEvent, GitService } from './git.ts';
import type { ProjectEvent, ProjectService } from './project.ts';
import type { ApprovalService, StatusEvent, StatusService } from './status.ts';
import type { TerminalDataMessage, TerminalEvent, TerminalHost } from './terminal.ts';
import type { WorkspaceEvent, WorkspaceService } from './workspace.ts';

export const CONTRACTS_VERSION = '0.1.6';

/** 所有从服务推给界面的事件。新增事件只能往这里加，不能改已有事件的形状。 */
export type AgentDeckEvent = AppEvent | ProjectEvent | WorkspaceEvent | TerminalEvent | StatusEvent | GitEvent | BoardEvent;
export type AgentDeckEventType = AgentDeckEvent['type'];
export type EventOf<T extends AgentDeckEventType> = Extract<AgentDeckEvent, { type: T }>;

/** 每个服务在 IPC 上的名字。 */
export interface Services {
  app: AppService;
  projects: ProjectService;
  workspaces: WorkspaceService;
  git: GitService;
  terminals: TerminalHost;
  agents: AgentService;
  status: StatusService;
  approvals: ApprovalService;
  board: BoardStore;
  browser: BrowserService;
}

export type ServiceName = keyof Services;

export interface AgentDeckApi extends Services {
  on<T extends AgentDeckEventType>(type: T, listener: (event: EventOf<T>) => void): Unsubscribe;
  /** 终端输出走单独的 MessagePort，不经过 on()。 */
  onTerminalData(listener: (message: TerminalDataMessage) => void): Unsubscribe;
  contractsVersion: typeof CONTRACTS_VERSION;
}

// ---- 线路约定 ----
// 1. 调用：ipcRenderer.invoke(IPC.invoke, { service, method, args }) → 结果，或 { error: AgentDeckErrorData }。
// 2. 事件：主进程 webContents.send(IPC.event, AgentDeckEvent)。
// 3. 终端输出：preload 启动时向主进程要一个 MessagePort（IPC.terminalPort），
//    tmux-host 所在的 utilityProcess 直接往这个端口写 TerminalDataMessage，不经过主进程转发。
// 4. 返回 void 且不等待的方法（terminals.write / resize、app.setBadge）用 ipcRenderer.send(IPC.send, ...)。

export const IPC = {
  invoke: 'agentdeck:invoke',
  send: 'agentdeck:send',
  event: 'agentdeck:event',
  terminalPort: 'agentdeck:terminal-port',
} as const;

export interface InvokeMessage<S extends ServiceName = ServiceName> {
  service: S;
  method: keyof Services[S] & string;
  args: unknown[];
}

/** 不等返回的方法名单，IPC 层据此选 send 还是 invoke。 */
export const FIRE_AND_FORGET: { readonly [S in ServiceName]?: readonly (keyof Services[S] & string)[] } = {
  terminals: ['write', 'resize'],
  app: ['setBadge'],
};

declare global {
  interface Window {
    agentdeck: AgentDeckApi;
  }
}
