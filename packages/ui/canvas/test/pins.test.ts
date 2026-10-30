// MP1 / MP2：左边管理面板的置顶随白板保存（BoardState.pins），New 菜单和右键白板同一份。
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSessionId, BoardPin, ProjectId, TerminalWindowData, WindowComponentProps, WindowId, WorkspaceId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import type { MenuItem } from '@agentdeck/ui-kit';
import { BoardController } from '../src/controller.ts';
import { newMenuItems } from '../src/react/BoardMenu.tsx';
import { createWindowRegistry } from '../src/registry.ts';

const Nothing = (_p: WindowComponentProps<any>) => null; // eslint-disable-line @typescript-eslint/no-explicit-any

let api: FakeApi;
let c: BoardController;

async function setup() {
  const registry = createWindowRegistry();
  registry.register<TerminalWindowData>({
    type: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 560, h: 360 },
    minSize: { w: 110, h: 60 },
    component: Nothing,
    create: (init) => ({ terminalId: null, agent: 'shell', cmd: 'zsh', args: [], cwd: '~', sessionId: null, startCommand: null, ...init }),
  });
  api = createFakeApi();
  c = new BoardController({ api, registry, homeDir: SAMPLE.home, autosaveMs: 0 });
  c.setPane({ w: 1200, h: 800 });
  await c.start();
}

afterEach(() => {
  c?.dispose();
  api?.dispose();
});

const session: BoardPin = { kind: 'session', agent: 'claude', sessionId: 'abc' as AgentSessionId };
const project: BoardPin = { kind: 'project', projectId: 'p1' as ProjectId };
const ws: BoardPin = { kind: 'workspace', workspaceId: 'w1' as WorkspaceId };

describe('pins', () => {
  it('old boards have none; toggling pins and unpins, saved with the board', async () => {
    await setup();
    expect(c.state.pins).toEqual([]);
    c.togglePin(session);
    c.togglePin(project);
    expect(c.isPinned({ ...session })).toBe(true);
    await c.flush();
    expect((await api.board.load()).pins).toEqual([session, project]);
    c.togglePin({ ...session });
    expect(c.state.pins).toEqual([project]);
    await c.flush();
    expect((await api.board.load()).pins).toEqual([project]);
  });

  it('movePin reorders and ignores bad indexes; pins come back on the next start', async () => {
    await setup();
    for (const p of [session, project, ws]) c.togglePin(p);
    c.movePin(2, 0);
    expect(c.state.pins).toEqual([ws, session, project]);
    c.movePin(0, 9);
    expect(c.state.pins).toEqual([ws, session, project]);
    await c.flush();
    const saved = await api.board.load();
    c.dispose();
    const again = new BoardController({ api, registry: createWindowRegistry(), homeDir: SAMPLE.home, autosaveMs: 0 });
    await again.start();
    expect(again.state.pins).toEqual(saved.pins);
    again.dispose();
  });
});

describe('New menu (MP2)', () => {
  it('Terminal ▸, Browser, Workspace…, Add project…; a new terminal goes into the focused workspace', async () => {
    await setup();
    const items = newMenuItems(c) as MenuItem[];
    expect(items.map((i) => i.label)).toEqual(['Terminal', 'Browser', 'Workspace…', 'Add project…']);
    // 只注册了终端：Browser 灰掉
    expect(items[1]!.disabled).toBe(true);
    const term = c.state.windows.find((w) => w.type === 'terminal' && w.workspaceId)!;
    c.focusWindow(term.id);
    const shell = (items[0]!.items as MenuItem[]).find((i) => i.id === 'agent-shell');
    const before = c.state.windows.length;
    const fresh = newMenuItems(c) as MenuItem[];
    (fresh[0]!.items as MenuItem[]).find((i) => i.id === (shell?.id ?? 'agent-shell'))!.onSelect!();
    await expect.poll(() => c.state.windows.length).toBe(before + 1);
    const added = c.state.windows[c.state.windows.length - 1]!;
    expect(added.workspaceId).toBe(term.workspaceId);
    expect(c.state.focusedId).toBe(added.id as WindowId);
  });
});
