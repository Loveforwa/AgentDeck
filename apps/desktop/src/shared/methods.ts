// 每个服务在 IPC 上能调的方法名单。
// contextBridge 只会复制对象上真实存在的键，不能直接暴露 JS Proxy，
// 所以 preload 按这张表给每个服务生成方法。下面的穷尽检查保证它和 contracts 的 Services 一致：
// contracts 加了方法而这里没加，类型检查就会报错。

import type { ServiceName, Services } from '@agentdeck/contracts';

type MethodsOf<S extends ServiceName> = keyof Services[S] & string;

export const SERVICE_METHODS = {
  app: [
    'homeDir',
    'pickFolder',
    'openInEditor',
    'openInSystemTerminal',
    'revealInFinder',
    'moveToTrash',
    'getSettings',
    'updateSettings',
    'quit',
    'setBadge',
    'setKeepAwake',
  ],
  projects: ['probe', 'add', 'list', 'update', 'remove', 'locate', 'initGit'],
  workspaces: ['create', 'list', 'rename', 'remove'],
  git: [
    'status',
    'stage',
    'unstage',
    'discard',
    'commit',
    'branches',
    'switchBranch',
    'createBranch',
    'deleteBranch',
    'stashes',
    'applyStash',
    'log',
    'diff',
    'worktrees',
    'addWorktree',
    'removeWorktree',
    'repoRoot',
    'repairWorktrees',
    'defaultBranch',
    'init',
  ],
  terminals: ['create', 'kill', 'list', 'attach', 'detach', 'write', 'resize', 'sendKeys', 'lastLines', 'attachCommand', 'recentLinks'],
  agents: ['list', 'refresh', 'start', 'check'],
  status: ['snapshot'],
  approvals: ['approve', 'setAutoApprove', 'history', 'setTerminalAutoApprove', 'autoApproveState', 'autoApproveSupport', 'autoApproveNeedsYou'],
  board: ['load', 'save'],
  browser: ['prepare', 'fileUrl', 'openExternal', 'ping'],
  usage: ['get', 'watch', 'unwatch'],
  skills: ['forTerminal', 'library', 'addSkill', 'addMcp'],
  subagents: ['list', 'watchTranscript', 'unwatchTranscript'],
  history: ['list'],
  sessions: ['list', 'get', 'children', 'rename', 'handoff', 'handoffSummary'],
  limits: ['list', 'resumeNow', 'skip', 'cancel', 'setOwner'],
  crew: [
    'create',
    'list',
    'get',
    'pause',
    'resume',
    'stop',
    'tasks',
    'sessions',
    'gates',
    'resolveGate',
    'digest',
    'decisions',
    'membership',
    'status',
    'spawn',
    'send',
    'read',
    'result',
    'wait',
    'diff',
    'check',
    'merge',
    'close',
    'ask',
    'note',
    'done',
  ],
} as const satisfies { readonly [S in ServiceName]: readonly MethodsOf<S>[] };

// 穷尽检查：漏掉的方法名会出现在报错信息里。
type Missing = {
  [S in ServiceName]: Exclude<MethodsOf<S>, (typeof SERVICE_METHODS)[S][number]>;
}[ServiceName];
const exhaustive: [Missing] extends [never] ? true : Missing = true;
void exhaustive;

export const SERVICE_NAMES = Object.keys(SERVICE_METHODS) as ServiceName[];
