// 左边栏：历史会话（MVP v3 · N11，画板 14）。把白板的状态和动作接到 @agentdeck/history-panel 上：
// 白板上开着的会话（按终端窗口的 agent + 会话 id）带状态灯，单击跳过去；Resume / Fork 在白板上新开终端，
// 用 agent 自己的接回参数（X4、X6 那一套）。

import { useMemo, type ReactNode } from 'react';
import type { SessionSummary, TerminalWindowData, WindowId, WindowNode, WorkspaceId } from '@agentdeck/contracts';
import { navWindow } from '@agentdeck/board-nav-panel';
import { HistoryPanel, sessionKey, type OpenSession, type PathGroup } from '@agentdeck/history-panel';
import { useBoardState, type BoardController } from '@agentdeck/ui-canvas';

export function HistorySidebar({ controller, headerActions }: { controller: BoardController; headerActions?: ReactNode }) {
  const projects = useBoardState((s) => s.projects);
  const workspaces = useBoardState((s) => s.workspaces);
  const frames = useBoardState((s) => s.frames);
  const windows = useBoardState((s) => s.windows);
  const statuses = useBoardState((s) => s.statuses);
  const badges = useBoardState((s) => s.badges);
  const activeProjectId = useBoardState((s) => {
    const id = controller.activeWorkspaceId(s);
    return id ? (s.workspaces[id]?.projectId ?? null) : null;
  });

  const onBoard = useMemo(() => new Set<string>(frames.map((f) => f.workspaceId)), [frames]);
  // 白板上开着的会话：终端窗口记着的会话 id，没有时看状态机报的（codex、omp 启动后才知道 id）
  const open = useMemo(() => {
    const out: Record<string, OpenSession> = {};
    for (const w of windows) {
      if (w.type !== 'terminal') continue;
      const data = w.data as TerminalWindowData;
      const id = data.sessionId ?? (data.terminalId ? statuses[data.terminalId]?.sessionId : null) ?? null;
      if (!id) continue;
      out[sessionKey(data.agent, id)] = { windowId: w.id, lamp: navWindow(w as WindowNode, { statuses, badges }).lamp ?? 'idle' };
    }
    return out;
  }, [windows, statuses, badges]);
  const forkTargets = useMemo(
    () =>
      frames.flatMap((f) => {
        const ws = workspaces[f.workspaceId];
        if (!ws) return [];
        const project = projects.find((p) => p.id === ws.projectId);
        return [{ id: ws.id, label: `${project?.name ?? ws.name} · ${ws.branch ?? ws.name}` }];
      }),
    [frames, workspaces, projects],
  );

  /** 新开终端前，工作区不在白板上就先把它的框放上来。 */
  const ensureFrame = (id: WorkspaceId | null): WorkspaceId | null => {
    if (!id) return null;
    const ws = controller.state.workspaces[id];
    if (ws) controller.addFrameFromService(ws);
    return ws ? id : null;
  };

  const resume = (s: SessionSummary, path: PathGroup) => {
    const workspaceId = ensureFrame(path.workspaceId);
    const cwd = s.cwd ?? path.cwd ?? undefined;
    void controller.newTerminal({ agent: s.agent, workspaceId, ...(cwd ? { cwd } : {}), mode: { kind: 'resume', sessionId: s.id } }).then((id) => {
      if (id) controller.jumpAndFlash(id);
    });
  };

  const fork = (s: SessionSummary, to: WorkspaceId) => {
    const workspaceId = ensureFrame(to);
    void controller.newTerminal({ agent: s.agent, workspaceId, mode: { kind: 'fork', sessionId: s.id } }).then((id) => {
      if (id) controller.jumpAndFlash(id);
    });
  };

  return (
    <HistoryPanel
      projects={projects}
      workspaces={workspaces}
      onBoard={onBoard}
      activeProjectId={activeProjectId}
      open={open}
      forkTargets={forkTargets}
      onJump={(id) => controller.jumpAndFlash(id as WindowId)}
      onResume={resume}
      onFork={fork}
      onCopyId={(s) => void navigator.clipboard?.writeText(s.id)}
      onReveal={(s) => void window.agentdeck.app.revealInFinder(s.file)}
      headerActions={headerActions}
    />
  );
}
