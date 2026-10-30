// 左边管理面板（MP2，画板“左边管理面板”MP0）。把白板的状态和动作接到 @agentdeck/manager-panel 上：
// 开着的窗口和历史会话合成一行，单击开着的跳过去，单击关掉的 Resume（用 agent 自己的接回参数，X4、X6 那一套）；
// 置顶存在 BoardState.pins（随白板保存）；New 菜单和右键白板是同一份（ui-canvas 的 newMenuItems）。

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionSummary, WindowId, WorkspaceId } from '@agentdeck/contracts';
import { agentReplyReader, ManagerPanel, type PathRef } from '@agentdeck/manager-panel';
import { newMenuItems, useBoardState, type BoardController } from '@agentdeck/ui-canvas';

export function ManagerSidebar({ controller, title, headerActions }: { controller: BoardController; title: string; headerActions?: ReactNode }) {
  const projects = useBoardState((s) => s.projects);
  const workspaces = useBoardState((s) => s.workspaces);
  const frames = useBoardState((s) => s.frames);
  const windows = useBoardState((s) => s.windows);
  const statuses = useBoardState((s) => s.statuses);
  const badges = useBoardState((s) => s.badges);
  const pins = useBoardState((s) => s.pins);
  const activeProjectId = useBoardState((s) => {
    const id = controller.activeWorkspaceId(s);
    return id ? (s.workspaces[id]?.projectId ?? null) : null;
  });
  // 悬停提示的最后一条回复：先读会话记录（agents.lastReply，contracts 0.1.22），读不到再认屏幕
  const lastReply = useMemo(() => agentReplyReader(controller.api), [controller]);

  // 家目录：Other folders 里的目录写成 ~ 开头
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    void window.agentdeck.app.homeDir().then(setHome, () => undefined);
  }, []);

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

  const resume = (s: SessionSummary, path: PathRef) => {
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

  const openWorkspace = (id: WorkspaceId) => {
    if (!ensureFrame(id)) return;
    controller.selectFrame(id);
    controller.fitFrame(id);
  };

  return (
    <ManagerPanel
      title={title}
      projects={projects}
      workspaces={workspaces}
      frames={frames}
      windows={windows}
      statuses={statuses}
      badges={badges}
      pins={pins}
      activeProjectId={activeProjectId}
      newMenu={() => newMenuItems(controller)}
      forkTargets={forkTargets}
      onTogglePin={(pin) => controller.togglePin(pin)}
      onMovePin={(from, to) => controller.movePin(from, to)}
      onJump={(id) => controller.jumpAndFlash(id as WindowId)}
      onResume={resume}
      onFork={fork}
      onCopyId={(id) => void navigator.clipboard?.writeText(id)}
      onReveal={(s) => void window.agentdeck.app.revealInFinder(s.file)}
      onRename={(id) => controller.openDialog({ kind: 'rename-window', windowId: id as WindowId })}
      onClose={(id) => controller.closeWindow(id as WindowId)}
      onOpenWorkspace={openWorkspace}
      api={controller.api}
      lastReply={lastReply}
      headerActions={headerActions}
      home={home}
    />
  );
}
