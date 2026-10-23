// 白板的 dev 页面：pnpm --filter @agentdeck/ui-canvas dev → http://localhost:5320
// window.agentdeck 是 tools/fakes 的 createFakeApi()（示例数据：2 个项目、3 个工作区、5 个终端、1 个网页窗口），
// 终端和网页用只显示文字的假窗口代替。右侧面板放演示按钮：让 agent 请求批准、提问、批准、一轮结束。
// 白板布局额外存进 localStorage，刷新页面能看到 B5 的恢复。
import '@agentdeck/design-tokens/fonts.css';
import '@agentdeck/ui-kit/base.css';
import './dev.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { BoardState, TerminalId } from '@agentdeck/contracts';
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
        <Button size="sm" onClick={() => api.scenario.devServerStarts(T.devServer)}>
          Dev server prints its URL
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
        <p>Right-click the board or a frame. Drag a terminal into another frame. Drag a corner below 320×200. ⌘J jumps to the next waiting window; ⌘0 / ⌘1 zoom; ⌘B hides this panel.</p>
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workbench api={api} controller={controller} renderPanel={(ctx) => <DemoPanel {...ctx} />} onOpenSettings={() => {}} />
  </StrictMode>,
);
