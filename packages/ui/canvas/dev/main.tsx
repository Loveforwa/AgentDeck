// 白板的 dev 页面：pnpm --filter @agentdeck/ui-canvas dev → http://localhost:5320
// window.agentdeck 是 tools/fakes 的 createFakeApi()（示例数据：2 个项目、3 个工作区、5 个终端、1 个网页窗口），
// 终端和网页用只显示文字的假窗口代替。右侧面板放演示按钮：让 agent 请求批准、提问、批准、一轮结束。
// 白板布局额外存进 localStorage，刷新页面能看到 B5 的恢复。
import '@agentdeck/design-tokens/fonts.css';
import '@agentdeck/ui-kit/base.css';
import './dev.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { BoardState, LimitedTerminalState, LimitOwner, SelfResumeState, TerminalId, WindowId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE } from '@agentdeck/fakes';
import { Button } from '@agentdeck/ui-kit';
import { BoardController, Workbench, type PanelContext } from '../src/index.ts';
import { registerFakeWindows } from './FakeWindows.tsx';

const STORAGE_KEY = 'agentdeck-dev-board';

const api = createFakeApi({ latencyMs: 40 });
window.agentdeck = api;
// 刷新后恢复上次的布局（假的 BoardStore 只在内存里）
const realLoad = api.board.load;
const realSave = api.board.save;
api.board.load = async () => {
  const saved = readSaved();
  return saved ?? realLoad();
};
api.board.save = async (state: BoardState) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式等情况存不了，照样存进假实现
  }
  return realSave(state);
};

function readSaved(): BoardState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BoardState) : null;
  } catch {
    return null;
  }
}

registerFakeWindows();
const controller = new BoardController({ api, homeDir: SAMPLE.home });
// 在控制台里看白板状态：__board.state
(window as unknown as { __board: BoardController }).__board = controller;
// 演示提醒：一开始就有一个在等批准（示例数据里的 codex），再让 claude 也问一个问题
setTimeout(() => api.scenario.agentAsks(SAMPLE.terminals.shopClaude, 'Should the coupon apply before tax?'), 1500);

const T = SAMPLE.terminals;

// N2：一个窗口组——feat/login 的 claude 用 open_terminals 开了 3 个子 agent，不用真的 agent 也能看到侧边栏。
// 子终端的 id 固定，刷新后恢复的布局还能对上；白板上还没有组时（新的或 Reset 过的白板）自动开出来。
const SUBAGENTS = [
  { id: 'term-sub-1' as TerminalId, label: 'api', output: '⏺ Edit src/routes/user.ts\r\n⏺ Bash pnpm test user\r\n  18 passed\r\n' },
  { id: 'term-sub-2' as TerminalId, label: 'ui', output: '⏺ Edit src/ui/LoginForm.tsx\r\n' },
  { id: 'term-sub-3' as TerminalId, label: 'tests', output: '⏺ Read tests/login.spec.ts\r\n  Done for now.\r\n' },
];
for (const s of SUBAGENTS) {
  api.fakes.terminals.createWith({ cmd: 'claude', args: [], cwd: SAMPLE.paths.agentdeckLogin }, { id: s.id, recording: null });
  api.fakes.status.track(s.id, { agent: 'claude', workspaceId: SAMPLE.workspaces.agentdeckLogin }, 'running');
  api.scenario.terminalOutput(s.id, s.output);
}
api.scenario.agentNeedsApproval(SUBAGENTS[1]!.id, { summary: 'Edit src/ui/LoginForm.tsx' });
api.scenario.agentTurnEnd(SUBAGENTS[2]!.id);
// sub-1 一直在输出，保持 running（停下来几秒假实现会把它记成 idle）
let tick = 0;
setInterval(() => api.scenario.terminalOutput(SUBAGENTS[0]!.id, `\r  Running pnpm test user… ${++tick}s`), 1000);

function openSubagentGroup() {
  api.bus.emit({
    type: 'board.open-group',
    lead: T.loginClaude,
    highlight: true,
    members: SUBAGENTS.map((s) => ({
      label: s.label,
      request: {
        type: 'terminal',
        workspaceId: SAMPLE.workspaces.agentdeckLogin,
        data: { terminalId: s.id, agent: 'claude', cmd: 'claude', args: [], cwd: SAMPLE.paths.agentdeckLogin, sessionId: null, startCommand: null },
      },
    })),
  });
}

const stopWaiting = controller.store.subscribe((s) => {
  if (!s.loaded) return;
  stopWaiting();
  if (!s.windows.some((w) => w.group)) openSubagentGroup();
  // #group：收起面板，100% 对准这个窗口组（截图用）
  if (location.hash === '#group') {
    setTimeout(() => {
      if (controller.state.panel.open) controller.togglePanel();
      const lead = controller.state.windows.find((w) => w.group?.role === 'lead');
      if (lead) controller.viewportApi?.setViewport({ x: 32 - lead.rect.x, y: 104 - lead.rect.y, zoom: 1 });
    }, 300);
  }
});

// PL2 Usage 的示例数据：右键终端 › PLUGINS › Usage 打开用量条。shop 的 claude 没有会话文件（No usage data）
const now = () => new Date().toISOString();
api.fakes.usage.set(T.loginClaude, {
  agent: 'claude',
  state: 'ok',
  reason: null,
  match: 'exact',
  model: 'claude-opus-5-5',
  total: { input: 312_000, output: 18_400, cacheRead: 1_400_000, cacheWrite: 86_000, reasoning: null },
  last: { input: 2_100, output: 640, cacheRead: 94_000, cacheWrite: 0, reasoning: null },
  requests: 37,
  context: { tokens: 96_000, window: 200_000, percent: 48, windowSource: 'model-table' },
  updatedAt: now(),
});
api.fakes.usage.set(T.loginCodex, {
  agent: 'codex',
  state: 'ok',
  reason: null,
  match: 'exact',
  model: 'gpt-5.5-codex',
  total: { input: 1_230_000, output: 64_200, cacheRead: 5_800_000, cacheWrite: null, reasoning: 41_000 },
  last: { input: 8_400, output: 1_200, cacheRead: 228_000, cacheWrite: null, reasoning: 800 },
  requests: 112,
  context: { tokens: 248_000, window: 272_000, percent: 91, windowSource: 'agent' },
  rateLimits: {
    primary: { usedPercent: 23, windowMinutes: 300, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
    secondary: { usedPercent: 41, windowMinutes: 10080, resetsAt: new Date(Date.now() + 3 * 86400_000).toISOString() },
  },
  updatedAt: now(),
});

function bumpUsage(id: TerminalId) {
  const cur = api.fakes.usage.get(id);
  void cur.then((u) => {
    if (u.state !== 'ok' || !u.total || !u.context) return;
    const last = { input: 1_800, output: 900, cacheRead: (u.context.tokens ?? 0) + 2_000, cacheWrite: 2_700, reasoning: null };
    const tokens = Math.min(u.context.window ?? Infinity, (u.context.tokens ?? 0) + 14_000);
    api.fakes.usage.set(id, {
      total: { ...u.total, input: u.total.input + last.input, output: u.total.output + last.output, cacheRead: u.total.cacheRead + last.cacheRead },
      last,
      requests: u.requests + 1,
      context: { ...u.context, tokens, percent: u.context.window ? (tokens / u.context.window) * 100 : null },
      updatedAt: now(),
    });
  });
}

// PL6：Auto-resume 书签的各种样子（FakeLimitService 直接摆出来，不等时间）。每组三个终端：feat/login 的 claude、codex，fix/cart-total 的 claude
type LimitPick = { state?: LimitedTerminalState; owner?: LimitOwner; selfResume?: SelfResumeState; autoResume?: boolean; messageDelivered?: boolean };
type LimitDemo = { label: string; resetsAt?: 'soon' | null; needsYou?: 'slept' | 'stale'; omp?: boolean; terms: [LimitPick, LimitPick, LimitPick] };
const LIMIT_DEMOS: LimitDemo[] = [
  { label: 'waiting', terms: [{ owner: 'agent', selfResume: 'waiting' }, { autoResume: true }, { autoResume: false }] },
  { label: 'running', terms: [{ owner: 'agent', selfResume: 'fired', state: 'resuming' }, { state: 'resuming', autoResume: true }, { state: 'gave-up' }] },
  { label: 'needs you', needsYou: 'stale', terms: [{ owner: 'agent', selfResume: 'stale' }, { state: 'took-over' }, { state: 'skipped' }] },
  { label: 'unknown', resetsAt: null, omp: true, terms: [{ state: 'idle' }, { autoResume: true }, { autoResume: true }] },
  { label: 'slept', needsYou: 'slept', terms: [{ owner: 'agent', selfResume: 'waiting', messageDelivered: true }, { autoResume: true }, { autoResume: true }] },
];
let limitDemo = -1;

function showLimitDemo(n: number) {
  limitDemo = ((n % LIMIT_DEMOS.length) + LIMIT_DEMOS.length) % LIMIT_DEMOS.length;
  const d = LIMIT_DEMOS[limitDemo]!;
  api.fakes.limits.clear();
  // omp 自己处理额度：把 fix/cart-total 的 claude 暂时当成 omp
  controller.updateData('win-shop-claude' as WindowId, { agent: d.omp ? 'omp' : 'claude' });
  const resetsAt = d.resetsAt === null ? null : new Date(Date.now() + 25 * 60_000).toISOString();
  const ids = [T.loginClaude, T.loginCodex, T.shopClaude];
  d.terms.forEach((t, i) => {
    api.fakes.limits.hit({
      agent: i === 1 ? 'codex' : 'claude',
      configDir: i === 1 ? '/Users/you/.codex' : `/Users/you/.claude-${i}`,
      resetsAt,
      terminals: [{ terminalId: ids[i]!, ...t }],
    });
  });
  // 假服务不认 needsYou / messageDelivered 的参数：直接改它的列表再发一次
  void api.limits.list().then((list) => {
    for (const a of list) {
      a.needsYou = d.resetsAt === null ? 'reset-unknown' : (d.needsYou ?? null);
      for (const t of a.terminals) {
        const pick = d.terms[ids.indexOf(t.terminalId)];
        if (pick?.messageDelivered) {
          t.messageDelivered = true;
          t.message = 'Use the new API instead.';
        }
      }
    }
    api.bus.emit({ type: 'limits.changed', limits: list });
  });
}
(window as unknown as { __limitDemo: (n: number) => void }).__limitDemo = showLimitDemo;

function DemoPanel({ workspace }: PanelContext) {
  const pendingFor = (id: TerminalId) => api.fakes.status.pending().find((p) => p.terminalId === id);
  return (
    <div className="dev-panel">
      <section>
        <h2>Source control</h2>
        <p>{workspace ? `${workspace.name} · ${workspace.path}` : 'Focus a window to see its workspace.'}</p>
        <p>Stand-in for the source control panel (line 3).</p>
      </section>
      <section>
        <h2>Demo</h2>
        <Button size="sm" onClick={() => api.scenario.agentNeedsApproval(T.loginClaude, { command: 'pnpm test auth' })}>
          claude in feat/login asks for approval
        </Button>
        <Button size="sm" onClick={() => api.scenario.agentAsks(T.shopClaude)}>
          claude in fix/cart-total asks a question
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const ids = api.fakes.status.pending().map((p) => p.id);
            if (ids.length) void api.approvals.approve(ids);
          }}
        >
          Approve all pending
        </Button>
        <Button
          size="sm"
          onClick={() => {
            for (const id of [T.shopClaude, T.loginClaude]) if (pendingFor(id)) api.scenario.agentTurnEnd(id);
          }}
        >
          Answer the questions (turn ends)
        </Button>
        <Button
          size="sm"
          onClick={() => {
            // 假服务不发 approval.needs-you（真服务会）：开着 Auto-approve 的终端碰到破坏性命令时，这里替它发
            const p = api.scenario.agentNeedsApproval(T.loginClaude, { command: 'rm -rf dist node_modules' });
            if (p) api.bus.emit({ type: 'approval.needs-you', terminalId: T.loginClaude, reason: 'destructive', request: p });
          }}
        >
          claude in feat/login wants rm -rf (Needs you)
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const p = api.scenario.agentAsks(T.loginClaude, 'Which database should I use?');
            api.bus.emit({ type: 'approval.needs-you', terminalId: T.loginClaude, reason: 'question', request: p });
          }}
        >
          claude in feat/login asks (Needs you)
        </Button>
        <Button
          size="sm"
          onClick={() => {
            api.scenario.agentTurnEnd(T.loginClaude);
            api.bus.emit({ type: 'approval.needs-you', terminalId: T.loginClaude, reason: null, request: null });
          }}
        >
          Handle it (bookmark back to red)
        </Button>
        <Button size="sm" onClick={() => bumpUsage(T.loginClaude)}>
          claude in feat/login makes a request (Usage)
        </Button>
        <Button size="sm" onClick={() => showLimitDemo(limitDemo + 1)}>
          Usage limit: next Auto-resume bookmarks
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            api.fakes.limits.clear();
            controller.updateData('win-shop-claude' as WindowId, { agent: 'claude' });
          }}
        >
          Usage limit: clear
        </Button>
        <Button size="sm" onClick={() => api.scenario.devServerStarts(T.devServer)}>
          Dev server prints its URL
        </Button>
        <Button size="sm" onClick={() => api.scenario.agentNeedsApproval(SUBAGENTS[0]!.id, { summary: 'pnpm test user' })}>
          sub-1 · api asks for approval
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            localStorage.removeItem(STORAGE_KEY);
            location.reload();
          }}
        >
          Reset the board
        </Button>
      </section>
      <section>
        <h2>Try</h2>
        <p>Right-click the board or a frame. Drag a terminal into another frame. Drag a corner below 320×200. ⌘J / ⌘⇧J jump to the next / previous waiting window; ⌘⇧] / ⌘⇧[ step through windows; ⌘0 / ⌘1 zoom; ⌘B hides this panel. Next to claude in feat/login, the sidebar lists its 3 subagents: click a row to switch, Show all, Collapse group.</p>
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workbench api={api} controller={controller} renderPanel={(ctx) => <DemoPanel {...ctx} />} onOpenSettingsFile={() => {}} />
  </StrictMode>,
);
