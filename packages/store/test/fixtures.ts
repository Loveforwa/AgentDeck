// 测试用的样例数据和临时目录。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentSessionId,
  ApprovalRecord,
  BoardState,
  Project,
  ProjectId,
  RequestId,
  Session,
  SessionId,
  TerminalId,
  WindowId,
  Workspace,
  WorkspaceId,
} from '@agentdeck/contracts';
import type { TerminalRecord } from '../src/index.ts';

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-store-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1' as ProjectId,
    name: 'web',
    kind: 'git',
    path: '/Users/me/code/web',
    repos: [{ name: '.', path: '/Users/me/code/web', baseBranch: 'main' }],
    worktreeRoot: '/Users/me/.agentdeck/worktrees/web',
    copyIntoWorktrees: ['.env', '.env.local'],
    setupCommand: 'pnpm install',
    missing: false,
    lastUsedAt: '2026-10-01T10:00:00.000Z',
    ...over,
  };
}

export function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w1' as WorkspaceId,
    projectId: 'p1' as ProjectId,
    name: 'feat/login',
    mode: 'worktree',
    path: '/Users/me/.agentdeck/worktrees/web/feat-login',
    branch: 'feat/login',
    repos: [{ name: '.', path: '/Users/me/.agentdeck/worktrees/web/feat-login', branch: 'feat/login' }],
    createdAt: '2026-10-02T09:00:00.000Z',
    missing: false,
    ...over,
  };
}

export function terminal(over: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    terminalId: 't1' as TerminalId,
    windowId: 'win1' as WindowId,
    workspaceId: 'w1' as WorkspaceId,
    agent: 'claude',
    cmd: 'claude',
    args: ['--session-id', 's-123'],
    cwd: '/Users/me/.agentdeck/worktrees/web/feat-login',
    sessionId: 's-123' as AgentSessionId,
    session: null,
    startCommand: null,
    lastStatus: 'running',
    exitCode: null,
    updatedAt: '2026-10-02T09:05:00.000Z',
    ...over,
  };
}

export function session(over: Partial<Session> = {}): Session {
  return {
    id: 'ses1' as SessionId,
    agent: 'claude',
    workspaceId: 'w1' as WorkspaceId,
    cwd: '/Users/me/.agentdeck/worktrees/web/feat-login',
    parentId: null,
    origin: { kind: 'user' },
    label: null,
    title: null,
    agentSessions: [{ id: 's-123' as AgentSessionId, startedAt: '2026-10-02T09:05:00.000Z', reason: 'start' }],
    terminalId: 't1' as TerminalId,
    state: 'running',
    handedOffTo: null,
    handoffNote: null,
    createdAt: '2026-10-02T09:05:00.000Z',
    updatedAt: '2026-10-02T09:05:00.000Z',
    ...over,
  };
}

export function approval(over: { id?: string; at?: string; workspaceId?: WorkspaceId | null } = {}): ApprovalRecord {
  return {
    request: {
      id: (over.id ?? 'r1') as RequestId,
      terminalId: 't1' as TerminalId,
      workspaceId: over.workspaceId === undefined ? ('w1' as WorkspaceId) : over.workspaceId,
      agent: 'claude',
      kind: 'approval',
      summary: 'pnpm test',
      command: 'pnpm test',
      destructive: false,
      at: '2026-10-02T09:10:00.000Z',
    },
    by: 'user',
    at: over.at ?? '2026-10-02T09:10:01.000Z',
  };
}

export function board(over: Partial<BoardState> = {}): BoardState {
  return {
    version: 1,
    viewport: { x: -120, y: 40, zoom: 0.75 },
    frames: [{ workspaceId: 'w1' as WorkspaceId, rect: { x: 0, y: 0, w: 1200, h: 800 }, z: 1, autoApprove: false }],
    windows: [
      {
        id: 'win1' as WindowId,
        type: 'terminal',
        workspaceId: 'w1' as WorkspaceId,
        rect: { x: 20, y: 40, w: 640, h: 400 },
        z: 2,
        title: null,
        restoreRect: null,
        data: {
          terminalId: 't1',
          agent: 'claude',
          cmd: 'claude',
          args: [],
          cwd: '/tmp',
          sessionId: null,
          startCommand: null,
        },
      },
      {
        id: 'win2' as WindowId,
        type: 'browser',
        workspaceId: null,
        rect: { x: 1400, y: 0, w: 800, h: 600 },
        z: 3,
        title: 'Docs',
        restoreRect: { x: 0, y: 0, w: 400, h: 300 },
        data: { url: 'http://localhost:5173/', mode: 'frame' },
      },
    ],
    panel: { open: false, width: 400 },
    savedAt: '2026-10-02T09:30:00.000Z',
    ...over,
  };
}
