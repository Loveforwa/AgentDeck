// 预置的示例数据：2 个项目、3 个工作区、5 个终端（一个在等批准）、一份白板。
// id 都是固定的，界面开发和测试可以直接引用 SAMPLE.xxx。

import type {
  BoardState,
  BrowserWindowData,
  Project,
  ProjectId,
  Rect,
  TerminalId,
  TerminalWindowData,
  WindowId,
  WindowNode,
  Workspace,
  WorkspaceId,
} from '@agentdeck/contracts';
import type { FakeServices } from './api.ts';
import { recordings } from './recording.ts';

const HOME = '/Users/you';
const T0 = '2026-10-23T08:00:00.000Z';

export const SAMPLE = {
  home: HOME,
  projects: {
    agentdeck: 'prj-agentdeck' as ProjectId,
    shop: 'prj-shop' as ProjectId,
  },
  workspaces: {
    agentdeckMain: 'ws-agentdeck-main' as WorkspaceId,
    agentdeckLogin: 'ws-agentdeck-login' as WorkspaceId,
    shopCart: 'ws-shop-cart' as WorkspaceId,
  },
  terminals: {
    /** Shell 跑着 pnpm dev，回放里会打印 http://localhost:5173/。 */
    devServer: 'term-dev-server' as TerminalId,
    /** claude，回放一段对话。 */
    loginClaude: 'term-login-claude' as TerminalId,
    /** codex，在等批准 pnpm test；回放停在 (y/n)，批准后继续。 */
    loginCodex: 'term-login-codex' as TerminalId,
    /** claude，已经空闲，有一段历史输出。 */
    shopClaude: 'term-shop-claude' as TerminalId,
    /** Shell，pnpm build 失败退出（error 状态）。 */
    shopShell: 'term-shop-shell' as TerminalId,
  },
  paths: {
    agentdeck: `${HOME}/code/agentdeck`,
    agentdeckLogin: `${HOME}/.agentdeck/worktrees/agentdeck/feat-login`,
    shop: `${HOME}/code/shop`,
    shopWeb: `${HOME}/code/shop/web`,
    shopApi: `${HOME}/code/shop/api`,
    shopCart: `${HOME}/.agentdeck/worktrees/shop/fix-cart-total`,
    /** 还没添加的 git 仓库，演示 Add project…。 */
    blog: `${HOME}/code/blog`,
    /** 没有 git 的文件夹，pickFolder 默认返回它。 */
    notes: `${HOME}/code/notes`,
  },
} as const;

const P = SAMPLE.paths;
const T = SAMPLE.terminals;
const W = SAMPLE.workspaces;

const SHOP_CLAUDE_HISTORY =
  '\u001b[2m>\u001b[0m Fix the cart total when a coupon is applied\r\n\r\n' +
  '⏺ The total was rounding before the discount. Fixed in web/src/cart.ts:14 and added a test.\r\n\r\n' +
  '\u001b[2m╭──────────────────────────────────────────────╮\u001b[0m\r\n' +
  '\u001b[2m│\u001b[0m >                                            \u001b[2m│\u001b[0m\r\n' +
  '\u001b[2m╰──────────────────────────────────────────────╯\u001b[0m\r\n';

const SHOP_SHELL_HISTORY =
  '\u001b[1m~/…/fix-cart-total/web\u001b[0m % pnpm build\r\n' +
  '\r\n> web@0.3.0 build\r\n> tsc && vite build\r\n\r\n' +
  'src/cart.ts:22:7 - \u001b[31merror\u001b[0m TS2322: Type \'string\' is not assignable to type \'number\'.\r\n\r\n' +
  'Found 1 error in src/cart.ts\u001b[2m:22\u001b[0m\r\n\r\n' +
  '\u001b[31m ELIFECYCLE \u001b[0m Command failed with exit code 2.\r\n';

function project(init: Pick<Project, 'id' | 'name' | 'kind' | 'path' | 'repos'> & Partial<Project>): Project {
  return {
    worktreeRoot: `${HOME}/.agentdeck/worktrees/${init.name}`,
    copyIntoWorktrees: ['.env', '.env.local'],
    setupCommand: null,
    missing: false,
    lastUsedAt: T0,
    ...init,
  };
}

function workspace(init: Omit<Workspace, 'createdAt' | 'missing'>): Workspace {
  return { ...init, createdAt: T0, missing: false };
}

function terminalWindow(
  id: string,
  workspaceId: WorkspaceId,
  rect: Rect,
  z: number,
  data: TerminalWindowData,
): WindowNode<TerminalWindowData> {
  return { id: id as WindowId, type: 'terminal', workspaceId, rect, z, title: null, restoreRect: null, data };
}

/** 把示例数据装进一组假服务。createFakeApi 默认会调用它。 */
export function seedSample(f: FakeServices): void {
  // ---- git ----
  f.git.addRepo({
    path: P.agentdeck,
    commits: ['Initial commit', 'Add Electron shell', 'Add board canvas', 'Add terminal window'],
    branches: [{ name: 'feat/login', commits: ['Add login route', 'Add login form'] }],
    tracking: {
      main: { upstream: 'origin/main' },
      'feat/login': { upstream: 'origin/feat/login', ahead: 1 },
    },
    worktrees: [
      {
        path: P.agentdeckLogin,
        branch: 'feat/login',
        changes: [
          { path: 'src/App.tsx', staged: 'modified' },
          { path: 'src/Login.tsx', unstaged: 'modified' },
          { path: 'src/login.test.ts', unstaged: 'untracked' },
        ],
      },
    ],
  });
  f.git.addRepo({
    path: P.shopWeb,
    commits: ['Initial commit', 'Add cart page', 'Add coupons'],
    branches: [{ name: 'fix/cart-total', commits: ['Round after discount'] }],
    worktrees: [{ path: `${P.shopCart}/web`, branch: 'fix/cart-total', changes: [{ path: 'src/cart.ts', unstaged: 'modified' }] }],
  });
  f.git.addRepo({
    path: P.shopApi,
    commits: ['Initial commit', 'Add orders endpoint'],
    worktrees: [{ path: `${P.shopCart}/api`, branch: 'fix/cart-total' }],
  });
  f.git.addRepo({ path: P.blog, commits: ['Initial commit', 'First post'] });

  // ---- 项目和工作区 ----
  f.projects.seed(
    project({
      id: SAMPLE.projects.agentdeck,
      name: 'agentdeck',
      kind: 'git',
      path: P.agentdeck,
      repos: [{ name: '.', path: P.agentdeck, baseBranch: 'main' }],
      setupCommand: 'pnpm install',
      lastUsedAt: '2026-10-23T09:30:00.000Z',
    }),
  );
  f.projects.seed(
    project({
      id: SAMPLE.projects.shop,
      name: 'shop',
      kind: 'multi-repo',
      path: P.shop,
      repos: [
        { name: 'api', path: P.shopApi, baseBranch: 'main' },
        { name: 'web', path: P.shopWeb, baseBranch: 'main' },
      ],
    }),
  );
  f.workspaces.seed(
    workspace({
      id: W.agentdeckMain,
      projectId: SAMPLE.projects.agentdeck,
      name: 'agentdeck',
      mode: 'main-folder',
      path: P.agentdeck,
      branch: 'main',
      repos: [{ name: '.', path: P.agentdeck, branch: 'main' }],
    }),
  );
  f.workspaces.seed(
    workspace({
      id: W.agentdeckLogin,
      projectId: SAMPLE.projects.agentdeck,
      name: 'feat/login',
      mode: 'worktree',
      path: P.agentdeckLogin,
      branch: 'feat/login',
      repos: [{ name: '.', path: P.agentdeckLogin, branch: 'feat/login' }],
    }),
  );
  f.workspaces.seed(
    workspace({
      id: W.shopCart,
      projectId: SAMPLE.projects.shop,
      name: 'fix/cart-total',
      mode: 'worktree',
      path: P.shopCart,
      branch: 'fix/cart-total',
      repos: [
        { name: 'api', path: `${P.shopCart}/api`, branch: 'fix/cart-total' },
        { name: 'web', path: `${P.shopCart}/web`, branch: 'fix/cart-total' },
      ],
    }),
  );

  // ---- 终端和状态 ----
  f.terminals.createWith(
    { cmd: '/bin/zsh', args: ['-lc', 'pnpm dev'], cwd: P.agentdeck },
    { id: T.devServer, recording: recordings.pnpmDev, command: 'node' },
  );
  f.terminals.createWith(
    { cmd: 'claude', args: ['--session-id', 'session-login'], cwd: P.agentdeckLogin },
    { id: T.loginClaude, recording: recordings.claudeChat },
  );
  f.terminals.createWith({ cmd: 'codex', args: [], cwd: P.agentdeckLogin }, { id: T.loginCodex, recording: recordings.approvalPrompt });
  f.terminals.createWith(
    { cmd: 'claude', args: ['--session-id', 'session-cart'], cwd: P.shopCart },
    { id: T.shopClaude, recording: null, history: SHOP_CLAUDE_HISTORY },
  );
  f.terminals.createWith(
    { cmd: '/bin/zsh', args: ['-l'], cwd: `${P.shopCart}/web` },
    { id: T.shopShell, recording: null, history: SHOP_SHELL_HISTORY, exited: 2 },
  );

  f.status.track(T.devServer, { agent: 'shell', workspaceId: W.agentdeckMain }, 'running');
  f.status.track(T.loginClaude, { agent: 'claude', workspaceId: W.agentdeckLogin }, 'running');
  f.status.track(T.loginCodex, { agent: 'codex', workspaceId: W.agentdeckLogin }, 'running');
  f.status.requestApproval(T.loginCodex, { summary: 'pnpm test', command: 'pnpm test' });
  f.status.track(T.shopClaude, { agent: 'claude', workspaceId: W.shopCart }, 'idle');
  f.status.track(T.shopShell, { agent: 'shell', workspaceId: W.shopCart }, 'starting');
  f.status.exited(T.shopShell, 2);

  // ---- 白板 ----
  const windows: WindowNode[] = [
    terminalWindow('win-dev-server', W.agentdeckMain, { x: 64, y: 96, w: 560, h: 340 }, 1, {
      terminalId: T.devServer,
      agent: 'shell',
      cmd: '/bin/zsh',
      args: ['-lc', 'pnpm dev'],
      cwd: P.agentdeck,
      sessionId: null,
      startCommand: 'pnpm dev',
    }),
    {
      id: 'win-browser' as WindowId,
      type: 'browser',
      workspaceId: W.agentdeckMain,
      rect: { x: 648, y: 96, w: 520, h: 340 },
      z: 2,
      title: null,
      restoreRect: null,
      data: { url: 'http://localhost:5173/', mode: 'frame' } satisfies BrowserWindowData,
    },
    terminalWindow('win-login-claude', W.agentdeckLogin, { x: 1264, y: 96, w: 620, h: 420 }, 3, {
      terminalId: T.loginClaude,
      agent: 'claude',
      cmd: 'claude',
      args: ['--session-id', 'session-login'],
      cwd: P.agentdeckLogin,
      sessionId: 'session-login' as TerminalWindowData['sessionId'],
      startCommand: null,
    }),
    terminalWindow('win-login-codex', W.agentdeckLogin, { x: 1904, y: 96, w: 560, h: 420 }, 4, {
      terminalId: T.loginCodex,
      agent: 'codex',
      cmd: 'codex',
      args: [],
      cwd: P.agentdeckLogin,
      sessionId: null,
      startCommand: null,
    }),
    terminalWindow('win-shop-claude', W.shopCart, { x: 64, y: 624, w: 620, h: 380 }, 5, {
      terminalId: T.shopClaude,
      agent: 'claude',
      cmd: 'claude',
      args: ['--session-id', 'session-cart'],
      cwd: P.shopCart,
      sessionId: 'session-cart' as TerminalWindowData['sessionId'],
      startCommand: null,
    }),
    terminalWindow('win-shop-shell', W.shopCart, { x: 704, y: 624, w: 520, h: 380 }, 6, {
      terminalId: T.shopShell,
      agent: 'shell',
      cmd: '/bin/zsh',
      args: ['-l'],
      cwd: `${P.shopCart}/web`,
      sessionId: null,
      startCommand: 'pnpm build',
    }),
  ];
  const board: BoardState = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 0.6 },
    frames: [
      { workspaceId: W.agentdeckMain, rect: { x: 32, y: 32, w: 1168, h: 436 }, z: 0, autoApprove: false },
      { workspaceId: W.agentdeckLogin, rect: { x: 1232, y: 32, w: 1264, h: 516 }, z: 0, autoApprove: false },
      { workspaceId: W.shopCart, rect: { x: 32, y: 560, w: 1224, h: 476 }, z: 0, autoApprove: false },
    ],
    windows,
    panel: { open: true, width: 340 },
    savedAt: T0,
  };
  void f.board.save(board);
  f.board.saves = 0;

  f.app.defaultPick = P.notes;
}
