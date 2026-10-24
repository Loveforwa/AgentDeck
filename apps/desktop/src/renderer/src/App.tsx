// 应用页面：顶栏 + 白板（@agentdeck/ui-canvas）+ 右侧源代码管理面板（@agentdeck/scm-panel；什么都没选中时是 @agentdeck/board-nav-panel 的快速定位列表）。
// tmux 起不来时显示说明页和 Retry；读登录 shell 环境失败等提示显示在左下角。
// AGENTDECK_DEMO=1 时自动把本仓库加成项目、建主目录工作区、开一个 Shell 和一个 claude（见 demo.ts）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentDeckErrorData, TerminalWindowData, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { BoardNav } from '@agentdeck/board-nav-panel';
import { ScmPanel } from '@agentdeck/scm-panel';
import { useBoardState, Workbench, type BoardController } from '@agentdeck/ui-canvas';
import { Button } from '@agentdeck/ui-kit';
import { OPEN_SETTINGS_EVENT } from '@agentdeck/ui-widget-terminal';
import type { StartupInfo } from '../../shared/desktop-bridge.ts';
import { reportBoardReady, runDemo } from './demo.ts';

/** 进程已经结束的状态。其余（starting / running / 在等你 / idle）都算“开着”。 */
const ENDED = new Set(['exited', 'error']);

/** 面板确认框里显示的名字：agent 用 agent 名，Shell 和自定义命令用命令名。 */
function terminalLabel(data: TerminalWindowData): string {
  if (data.agent !== 'shell' && data.agent !== 'custom') return data.agent;
  const cmd = data.cmd.split('/').pop() ?? '';
  return cmd === '' ? 'shell' : cmd;
}


/** 什么都没选中时的快速定位列表（V5）：整块白板的目录，单击一行和 ⌘J 一样跳过去。 */
function BoardNavPanel({ controller }: { controller: BoardController }) {
  const projects = useBoardState((s) => s.projects);
  const workspaces = useBoardState((s) => s.workspaces);
  const frames = useBoardState((s) => s.frames);
  const windows = useBoardState((s) => s.windows);
  const statuses = useBoardState((s) => s.statuses);
  const badges = useBoardState((s) => s.badges);
  return (
    <BoardNav
      projects={projects}
      workspaces={workspaces}
      frames={frames}
      windows={windows}
      statuses={statuses}
      badges={badges}
      onJump={(id) => controller.jumpAndFlash(id)}
    />
  );
}

/** 右侧面板：跟着聚焦的窗口（或选中的框）所在的工作区；什么都没选中时是快速定位列表。 */
function SidePanel({ workspace, controller }: { workspace: Workspace | null; controller: BoardController }) {
  const nothingSelected = useBoardState((s) => s.focusedId === null && s.selectedFrame === null);
  const wsId = workspace?.id ?? null;
  // 这个工作区目录里开着的终端，不管在跑还是空闲（Q38：切分支前只要有一个就确认）。
  // 用字符串做选择结果，避免每次渲染都是新数组。
  const open = useBoardState((s) => {
    if (!wsId) return '';
    const names = new Set<string>();
    for (const w of s.windows) {
      if (w.type !== 'terminal' || w.workspaceId !== wsId) continue;
      const data = w.data as TerminalWindowData;
      if (!data.terminalId) continue; // 还没起来，或重启后会话已经没了
      const st = s.statuses[data.terminalId];
      if (st && ENDED.has(st.status)) continue;
      names.add(terminalLabel(data));
    }
    return [...names].sort().join(',');
  });
  const openTerminals = useMemo(() => (open ? open.split(',') : []), [open]);
  const goTo = (id: WorkspaceId) => {
    controller.selectFrame(id);
    controller.fitFrame(id);
  };
  if (nothingSelected) return <BoardNavPanel controller={controller} />;
  return <ScmPanel workspaceId={wsId} onGoToWorkspace={goTo} openTerminals={openTerminals} />;
}

function TmuxMissing({ error, onRetry }: { error: AgentDeckErrorData; onRetry: () => void }) {
  return (
    <div className="app-blocker" role="alert">
      <h1>AgentDeck needs tmux</h1>
      <p>{error.message}</p>
      {error.detail ? <pre>{error.detail}</pre> : null}
      <p className="app-muted">Install it with Homebrew, then retry:</p>
      <pre>brew install tmux</pre>
      <Button variant="primary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function App({ controller, loaded, startup }: { controller: BoardController; loaded: Promise<void>; startup: StartupInfo }) {
  const [tmuxError, setTmuxError] = useState(startup.tmuxError);
  const [notices, setNotices] = useState(startup.warnings);

  const addNotice = useCallback((message: string) => setNotices((all) => (all.includes(message) ? all : [...all, message])), []);
  // Settings 对话框底部的 Open settings.json：用编辑器打开；打不开时主进程在 Finder 里显示它，这里把原因告诉用户（IS-47）
  const openSettingsFile = useCallback(() => {
    void window.agentdeckDesktop
      ?.openSettings()
      .then((res) => {
        if (res?.opened === 'finder') addNotice(res.message);
      })
      .catch((e: unknown) => addNotice(`Couldn’t open settings: ${e instanceof Error ? e.message : String(e)}`));
  }, [addNotice]);

  useEffect(() => window.agentdeckDesktop?.onNotice(addNotice), [addNotice]);

  // 终端窗口里的设置链接（detail.section 是 'agents'，那一页还没有，先到 General，默认 agent 在那里）
  useEffect(() => {
    const onOpen = () => controller.openSettings({ section: 'general' });
    document.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => document.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, [controller]);

  useEffect(() => {
    let cancelled = false;
    void loaded.then(async () => {
      if (cancelled) return;
      if (startup.demo) {
        await runDemo(controller, window.agentdeck, startup.demo.repoPath).catch((e: unknown) => {
          console.error('[demo]', e);
          setNotices((n) => [...n, `Demo setup failed: ${e instanceof Error ? e.message : String(e)}`]);
        });
      }
      if (startup.screenshot) reportBoardReady(controller);
    });
    return () => {
      cancelled = true;
    };
    // 只在启动时跑一次
  }, [controller, loaded, startup]);

  const retry = () => {
    void window.agentdeckDesktop?.retryTmux().then((err) => setTmuxError(err ?? null));
  };

  if (tmuxError) return <TmuxMissing error={tmuxError} onRetry={retry} />;

  return (
    <>
      <Workbench
        api={window.agentdeck}
        controller={controller}
        onOpenSettingsFile={openSettingsFile}
        renderPanel={({ workspace }) => <SidePanel workspace={workspace} controller={controller} />}
      />
      {notices.length > 0 ? (
        <div className="app-notices" role="status">
          {notices.map((n, i) => (
            <div className="app-notice" key={i}>
              <span>{n}</span>
              <Button size="sm" variant="ghost" onClick={() => setNotices((all) => all.filter((_, j) => j !== i))}>
                Dismiss
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
