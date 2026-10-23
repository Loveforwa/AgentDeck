// 应用页面：顶栏 + 白板（@agentdeck/ui-canvas）+ 右侧源代码管理面板（@agentdeck/scm-panel）。
// tmux 起不来时显示说明页和 Retry；读登录 shell 环境失败等提示显示在左下角。
// AGENTDECK_DEMO=1 时自动把本仓库加成项目、建主目录工作区、开一个 Shell 和一个 claude（见 demo.ts）。

import { useEffect, useMemo, useState } from 'react';
import { WAITING_STATUSES, type AgentDeckErrorData, type TerminalWindowData, type Workspace, type WorkspaceId } from '@agentdeck/contracts';
import { ScmPanel } from '@agentdeck/scm-panel';
import { useBoardState, Workbench, type BoardController } from '@agentdeck/ui-canvas';
import { Button } from '@agentdeck/ui-kit';
import { OPEN_SETTINGS_EVENT } from '@agentdeck/ui-widget-terminal';
import type { StartupInfo } from '../../shared/desktop-bridge.ts';
import { reportBoardReady, runDemo } from './demo.ts';

const ACTIVE = new Set(['starting', 'running', ...WAITING_STATUSES]);

function openSettings(): void {
  void window.agentdeckDesktop?.openSettings().catch((e: unknown) => console.error(e));
}

/** 右侧面板：跟着聚焦的窗口（或选中的框）所在的工作区。 */
function SidePanel({ workspace, controller }: { workspace: Workspace | null; controller: BoardController }) {
  const wsId = workspace?.id ?? null;
  // 这个工作区里正在跑的 agent（切分支前提示）。用字符串做选择结果，避免每次渲染都是新数组。
  const running = useBoardState((s) => {
    if (!wsId) return '';
    const names = new Set<string>();
    for (const w of s.windows) {
      if (w.type !== 'terminal' || w.workspaceId !== wsId) continue;
      const data = w.data as TerminalWindowData;
      const st = data.terminalId ? s.statuses[data.terminalId] : undefined;
      if (data.agent !== 'shell' && st && ACTIVE.has(st.status)) names.add(data.agent);
    }
    return [...names].sort().join(',');
  });
  const runningAgents = useMemo(() => (running ? running.split(',') : []), [running]);
  const goTo = (id: WorkspaceId) => {
    controller.selectFrame(id);
    controller.fitFrame(id);
  };
  return <ScmPanel workspaceId={wsId} onGoToWorkspace={goTo} runningAgents={runningAgents} />;
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

  useEffect(() => {
    const onOpen = () => openSettings();
    document.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => document.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, []);

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
        onOpenSettings={openSettings}
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
