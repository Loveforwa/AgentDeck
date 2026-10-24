// dev 页面：pnpm --filter @agentdeck/scm-panel dev → http://localhost:5347
// 左边模拟白板上的聚焦和各种事件，右边是真正的面板，数据来自 tools/fakes 的 createFakeApi()。

import '@agentdeck/design-tokens/fonts.css';
import '@agentdeck/ui-kit/base.css';
import './dev.css';

import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { GitService, LogOptions, TerminalId, Workspace, WorkspaceId } from '@agentdeck/contracts';
import { SAMPLE, createFakeApi } from '@agentdeck/fakes';
import { Button } from '@agentdeck/ui-kit';
import { ScmPanel, type ScmApi } from '../src/index.ts';
import { demoBranches, demoLog } from './demo-graph.ts';

const fake = createFakeApi({ latencyMs: 60 });
const P = SAMPLE.paths;
const W = SAMPLE.workspaces;

/** 每个工作区里“在跑”的 agent 终端，演示 agent 一轮结束。 */
const AGENT_OF: Partial<Record<WorkspaceId, { terminal: TerminalId; agent: string }>> = {
  [W.agentdeckMain]: { terminal: SAMPLE.terminals.devServer, agent: 'shell' },
  [W.agentdeckLogin]: { terminal: SAMPLE.terminals.loginClaude, agent: 'claude' },
  [W.shopCart]: { terminal: SAMPLE.terminals.shopClaude, agent: 'claude' },
};

/** git 调用前多等一会儿，看 Refreshing…；顺便数一数面板调了几次 status。 */
const slow = { on: false };
/** 示范提交图（N5）：agentdeck 这个仓库的 graph / commit 查询换成 dev/demo-graph.ts 里编的图。 */
const demo = { on: true };
const isAgentdeck = (repo: unknown) => repo === P.agentdeck || repo === P.agentdeckLogin;
const statusCalls = { n: 0, listener: (_n: number) => {} };
const slowGit = new Proxy(fake.git, {
  get(target, prop, receiver) {
    const value: unknown = Reflect.get(target, prop, receiver);
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      if (prop === 'status') statusCalls.listener(++statusCalls.n);
      if (slow.on) await new Promise((r) => setTimeout(r, 1500));
      const [repo, , opts] = args as [string, unknown, LogOptions | undefined];
      if (demo.on && prop === 'log' && isAgentdeck(repo) && (opts?.graph || opts?.commit)) {
        const s = await target.status(repo);
        return demoLog(s.branch, s.head, opts);
      }
      if (demo.on && prop === 'branches' && isAgentdeck(repo)) return demoBranches(await target.branches(repo));
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
}) as GitService;

const api: ScmApi = { ...fake, git: slowGit };

let edits = 0;

function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [focus, setFocus] = useState<WorkspaceId | null>(W.agentdeckLogin);
  const [dark, setDark] = useState(false);
  const [slowOn, setSlowOn] = useState(false);
  const [demoOn, setDemoOn] = useState(demo.on);
  const [agentRunning, setAgentRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [gitCalls, setGitCalls] = useState(0);
  const note = (s: string) => setLog((l) => [s, ...l].slice(0, 8));

  // 主题放在 <html> 上：菜单、对话框渲染到 body 里，也要跟着变
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  useEffect(() => {
    const load = () => void fake.workspaces.list().then(setWorkspaces);
    load();
    const offs = [fake.on('workspace.changed', load), fake.on('workspace.removed', load)];
    return () => offs.forEach((off) => off());
  }, []);

  // 面板调 git.status 的次数：只有切换、一轮结束、自己操作、手动刷新时才会涨
  useEffect(() => {
    statusCalls.listener = setGitCalls;
    setGitCalls(statusCalls.n);
  }, []);

  const ws = workspaces.find((w) => w.id === focus) ?? null;
  const agent = focus ? AGENT_OF[focus] : undefined;
  const firstRepo = ws?.repos[0]?.path ?? null;

  const actions = useMemo(
    () => [
      {
        label: 'Agent turn ends with new changes',
        hint: 'agent.turn-end → the panel refreshes (status calls +1)',
        disabled: !agent || !firstRepo,
        run: () => {
          if (!agent || !firstRepo) return;
          edits += 1;
          fake.scenario.agentTurnEnd(agent.terminal, {
            repo: firstRepo,
            files: [{ path: `src/agent/edit-${edits}.ts`, unstaged: 'untracked' }],
          });
          note(`agent.turn-end in ${ws?.name}`);
        },
      },
      {
        label: 'Edit files outside the app',
        hint: 'changes pushed with git.status (no extra git call)',
        disabled: !firstRepo,
        run: () => {
          if (!firstRepo) return;
          fake.scenario.gitChanged(firstRepo, [
            { path: 'README.md', unstaged: 'modified' },
            { path: 'docs/notes.md', unstaged: 'untracked' },
          ]);
          note('git.status pushed');
        },
      },
      {
        label: 'Start a merge with a conflict',
        hint: 'Merging, conflicts on top',
        disabled: !firstRepo,
        run: () => {
          if (!firstRepo) return;
          fake.fakes.git.addChanges(firstRepo, { path: 'src/conflict.ts', staged: 'modified', unstaged: 'modified', conflicted: true });
          fake.fakes.git.setOperation(firstRepo, 'merge');
          note('merge in progress');
        },
      },
      {
        label: 'Make the main folder dirty',
        hint: 'then switch its branch: Stash and switch',
        disabled: false,
        run: () => {
          fake.scenario.gitChanged(P.agentdeck, [
            { path: 'src/main.ts', unstaged: 'modified' },
            { path: 'src/board/Canvas.tsx', staged: 'modified' },
          ]);
          setFocus(W.agentdeckMain);
          note('2 changes in agentdeck main folder');
        },
      },
      {
        label: 'Add plain folder “notes”',
        hint: 'Initialize Repository',
        disabled: false,
        run: async () => {
          const [p] = await fake.projects.add({ folder: P.notes, as: 'plain' });
          if (!p) return;
          const existing = (await fake.workspaces.list()).find((w) => w.projectId === p.id);
          const w = existing ?? (await fake.workspaces.create({ projectId: p.id, mode: 'main-folder' })).workspace;
          setWorkspaces(await fake.workspaces.list());
          setFocus(w.id);
          note('notes added');
        },
      },
    ],
    [agent, firstRepo, ws?.name],
  );

  return (
    <div className="dev">
      <main className="dev-board">
        <header className="dev-header">
          <span className="dev-title">Source control panel</span>
          <span className="dev-subtitle">Fake services from tools/fakes · git.status calls: {gitCalls}</span>
        </header>

        <section className="dev-card">
          <h2>Focused window</h2>
          <div className="dev-focus" role="radiogroup" aria-label="Focused window">
            {workspaces.map((w) => (
              <label key={w.id} className="dev-radio">
                <input type="radio" name="focus" checked={focus === w.id} onChange={() => setFocus(w.id)} />
                <span>
                  {w.name}
                  <span className="dev-muted">
                    {' '}
                    · {w.mode === 'main-folder' ? 'main folder' : 'worktree'}
                    {w.repos.length > 1 ? ` · ${w.repos.length} repos` : ''}
                  </span>
                </span>
              </label>
            ))}
            <label className="dev-radio">
              <input type="radio" name="focus" checked={focus === null} onChange={() => setFocus(null)} />
              <span>A loose window (not in a workspace)</span>
            </label>
          </div>
        </section>

        <section className="dev-card">
          <h2>Simulate</h2>
          <div className="dev-actions">
            {actions.map((a) => (
              <div key={a.label} className="dev-action">
                <Button size="sm" disabled={a.disabled} onClick={() => void a.run()}>
                  {a.label}
                </Button>
                <span className="dev-muted">{a.hint}</span>
              </div>
            ))}
          </div>
          <div className="dev-toggles">
            <label className="dev-radio">
              <input
                type="checkbox"
                checked={slowOn}
                onChange={(e) => {
                  slow.on = e.target.checked;
                  setSlowOn(e.target.checked);
                }}
              />
              <span>Slow git (1.5 s per call) — shows Refreshing…</span>
            </label>
            <label className="dev-radio">
              <input type="checkbox" checked={agentRunning} onChange={(e) => setAgentRunning(e.target.checked)} />
              <span>An agent is running in this workspace (warns before switching branches)</span>
            </label>
            <label className="dev-radio">
              <input
                type="checkbox"
                checked={demoOn}
                onChange={(e) => {
                  demo.on = e.target.checked;
                  setDemoOn(e.target.checked);
                }}
              />
              <span>Demo commit graph for agentdeck (forks, merges, merged branches) — press Refresh after changing</span>
            </label>
            <label className="dev-radio">
              <input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} />
              <span>Dark</span>
            </label>
          </div>
        </section>

        <section className="dev-card">
          <h2>Events</h2>
          {log.length === 0 ? <p className="dev-muted">Nothing yet.</p> : log.map((l, i) => <p key={i} className="dev-log">{l}</p>)}
        </section>
      </main>

      <div className="dev-panel">
        <ScmPanel
          api={api}
          workspaceId={focus}
          openTerminals={agentRunning && agent ? [agent.agent === 'shell' ? 'claude' : agent.agent] : []}
          onGoToWorkspace={(id) => {
            setFocus(id);
            note(`Board pans to ${workspaces.find((w) => w.id === id)?.name ?? id}`);
          }}
        />
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
