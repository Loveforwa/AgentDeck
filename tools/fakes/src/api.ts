// createFakeApi()：把所有假服务接到一个总线上，返回一个可以直接当 window.agentdeck 用的对象。

import { CONTRACTS_VERSION, FIRE_AND_FORGET } from '@agentdeck/contracts';
import type {
  AbsPath,
  AgentDeckApi,
  CreateTerminalRequest,
  PendingRequest,
  ProjectId,
  ServiceName,
  Services,
  TerminalId,
  WorkspaceId,
} from '@agentdeck/contracts';
import { FakeAgentService } from './agent-service.ts';
import { FakeAppService } from './app-service.ts';
import { FakeBoardStore } from './board-store.ts';
import { FakeBrowserService } from './browser-service.ts';
import { FakeEventBus } from './bus.ts';
import type { FakeChangeInit } from './git-service.ts';
import { FakeGitService } from './git-service.ts';
import { FakeProjectService } from './project-service.ts';
import { recordings } from './recording.ts';
import type { Recording } from './recording.ts';
import { seedSample } from './sample.ts';
import { FakeApprovalService, FakeStatusService } from './status-service.ts';
import { FakeTerminalHost } from './terminal-host.ts';
import { FakeUsageService } from './usage-service.ts';
import { bindMethods, sleep } from './util.ts';
import { FakeWorkspaceService } from './workspace-service.ts';

/** 具体的假服务实例，带各自的控制方法。 */
export interface FakeServices {
  app: FakeAppService;
  projects: FakeProjectService;
  workspaces: FakeWorkspaceService;
  git: FakeGitService;
  terminals: FakeTerminalHost;
  agents: FakeAgentService;
  status: FakeStatusService;
  approvals: FakeApprovalService;
  board: FakeBoardStore;
  browser: FakeBrowserService;
  usage: FakeUsageService;
}

export interface CreateFakeApiOptions {
  /** 装入示例数据（2 个项目、3 个工作区、5 个终端），默认 true。 */
  seed?: boolean;
  /** 每个返回 Promise 的方法先等这么久，模拟跨进程调用。默认 0。 */
  latencyMs?: number;
  /** 终端回放什么时候开始，默认 'attach'。 */
  playOn?: 'attach' | 'create';
  /** 终端多久没输出发 silence，默认 3000。 */
  silenceMs?: number;
  /** 新开的终端用哪段录制。默认按命令挑：claude → claudeChat，pnpm/npm/yarn dev → pnpmDev。 */
  recordingFor?: (req: CreateTerminalRequest) => Recording | null;
  home?: AbsPath;
}

export interface FakeApi extends AgentDeckApi {
  /** 具体的假服务，用来预置数据、查看调用记录。 */
  fakes: FakeServices;
  bus: FakeEventBus;
  scenario: Scenario;
  /** 停掉所有计时器（终端回放、silence）。 */
  dispose(): void;
}

export function defaultRecordingFor(req: CreateTerminalRequest): Recording | null {
  const line = [req.cmd, ...req.args].join(' ');
  if (/(^|\/)claude$/.test(req.cmd)) return recordings.claudeChat;
  if (/\b(pnpm|npm|yarn)\s+(run\s+)?dev\b/.test(line)) return recordings.pnpmDev;
  return null;
}

/** 只建服务、不装数据。想自己预置数据时用它，再调 seedSample 或自己的函数。 */
export function createFakeServices(opts: CreateFakeApiOptions = {}): { bus: FakeEventBus; fakes: FakeServices } {
  const bus = new FakeEventBus();
  const app = opts.home === undefined ? new FakeAppService({ bus }) : new FakeAppService({ bus, home: opts.home });
  const git = new FakeGitService({ bus });
  const terminalOpts: ConstructorParameters<typeof FakeTerminalHost>[0] = {
    bus,
    recordingFor: opts.recordingFor ?? defaultRecordingFor,
  };
  if (opts.playOn) terminalOpts.playOn = opts.playOn;
  if (opts.silenceMs !== undefined) terminalOpts.silenceMs = opts.silenceMs;
  const terminals = new FakeTerminalHost(terminalOpts);
  const status = new FakeStatusService({ bus, destructivePatterns: () => app.current().approvals.destructivePatterns });
  const agents = new FakeAgentService({
    terminals,
    status,
    extraArgs: (agent) => app.current().agents[agent]?.extraArgs ?? [],
  });
  const approvals = new FakeApprovalService({ status, terminals, approveKeys: (agent) => agents.approveOnceKeys(agent) });
  const projects = opts.home === undefined ? new FakeProjectService({ bus, git }) : new FakeProjectService({ bus, git, home: opts.home });
  const workspaces = new FakeWorkspaceService({ bus, projects, git });
  const fakes: FakeServices = {
    app,
    projects,
    workspaces,
    git,
    terminals,
    agents,
    status,
    approvals,
    board: new FakeBoardStore(),
    browser: new FakeBrowserService(),
    usage: new FakeUsageService({ bus }),
  };
  for (const f of Object.values(fakes)) bindMethods(f);
  return { bus, fakes };
}

export function createFakeApi(opts: CreateFakeApiOptions = {}): FakeApi {
  const { bus, fakes } = createFakeServices(opts);
  if (opts.seed ?? true) {
    seedSample(fakes);
    bus.clearLog();
  }
  const latency = opts.latencyMs ?? 0;
  const svc = <S extends ServiceName>(name: S): Services[S] =>
    (latency > 0 ? withLatency(name, fakes[name], latency) : fakes[name]) as Services[S];
  return {
    app: svc('app'),
    projects: svc('projects'),
    workspaces: svc('workspaces'),
    git: svc('git'),
    terminals: svc('terminals'),
    agents: svc('agents'),
    status: svc('status'),
    approvals: svc('approvals'),
    board: svc('board'),
    browser: svc('browser'),
    usage: svc('usage'),
    on: (type, listener) => bus.on(type, listener),
    onTerminalData: (listener) => bus.onTerminalData(listener),
    contractsVersion: CONTRACTS_VERSION,
    fakes,
    bus,
    scenario: new Scenario(fakes),
    dispose: () => fakes.terminals.dispose(),
  };
}

/** 给每个方法加延迟。不等待的方法（FIRE_AND_FORGET 名单）保持同步。 */
function withLatency<T extends object>(name: ServiceName, target: T, ms: number): T {
  const sync = new Set<string>((FIRE_AND_FORGET[name] ?? []) as readonly string[]);
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string' || sync.has(prop)) return value;
      return async (...args: unknown[]) => {
        await sleep(ms);
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

/**
 * 演示和测试用的剧本：一句话把系统推到某个状态。
 * 都是同步的，事件立刻发出。
 */
export class Scenario {
  constructor(private readonly f: FakeServices) {}

  /** agent 请求批准：终端里打印确认提示，状态变 needs-approval。工作区开了 Auto-approve 时会被自动批准，返回 null。 */
  agentNeedsApproval(
    terminalId: TerminalId,
    req: { summary?: string; command?: string | null } = {},
  ): PendingRequest | null {
    const command = req.command === undefined ? 'pnpm test' : req.command;
    const summary = req.summary ?? command ?? 'Edit files';
    this.feedIfAlive(terminalId, `\r\n\u001b[33mAllow command?\u001b[0m\r\n  \u001b[2m$\u001b[0m ${summary}\r\n  \u001b[1m(y/n)\u001b[0m `);
    return this.f.status.requestApproval(terminalId, { summary, command });
  }

  /** agent 用提问工具问你，状态变 needs-reply。 */
  agentAsks(terminalId: TerminalId, question = 'Which database should I use?'): PendingRequest {
    this.feedIfAlive(terminalId, `\r\n⏺ ${question}\r\n\r\n\u001b[2m>\u001b[0m `);
    return this.f.status.askQuestion(terminalId, question);
  }

  agentRunning(terminalId: TerminalId): void {
    this.f.status.running(terminalId);
  }

  /** 一轮结束：状态变 idle，发 agent.turn-end；给了 changes 就同时改 git（模拟 agent 改了文件）。 */
  agentTurnEnd(terminalId: TerminalId, changes?: { repo: AbsPath; files: FakeChangeInit[] }): void {
    if (changes) this.f.git.addChanges(changes.repo, ...changes.files);
    this.f.status.turnEnd(terminalId);
  }

  terminalOutput(terminalId: TerminalId, data: string): void {
    this.f.terminals.feed(terminalId, data);
  }

  terminalExits(terminalId: TerminalId, code = 0): void {
    this.f.terminals.exit(terminalId, code);
  }

  /** 终端里打印 Vite 的 Local 地址，发 terminal.link。 */
  devServerStarts(terminalId: TerminalId, url = 'http://localhost:5173/'): void {
    this.f.terminals.feed(terminalId, `\r\n  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36m${url}\u001b[39m\r\n`);
  }

  /** 用户在外面改了文件：设置改动并发 git.status。 */
  gitChanged(repo: AbsPath, files: FakeChangeInit[]): void {
    this.f.git.addChanges(repo, ...files);
  }

  projectFolderMissing(projectId: ProjectId, missing = true): void {
    this.f.projects.setMissing(projectId, missing);
  }

  workspaceFolderMissing(workspaceId: WorkspaceId, missing = true): void {
    this.f.workspaces.setMissing(workspaceId, missing);
  }

  /** tmux 服务没了（例如电脑重启）。 */
  hostLost(): void {
    this.f.terminals.hostLost();
  }

  /** 单击了系统通知。 */
  notificationClicked(terminalId: TerminalId): void {
    this.f.app.focusTerminal(terminalId);
  }

  /** 网页窗口的服务挂了 / 恢复了。 */
  serverDown(url: string, down = true): void {
    this.f.browser.setReachable(url, !down);
  }

  private feedIfAlive(terminalId: TerminalId, data: string): void {
    if (this.f.terminals.has(terminalId) && this.f.terminals.get(terminalId).alive) this.f.terminals.feed(terminalId, data);
  }
}
