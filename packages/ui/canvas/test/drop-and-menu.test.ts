import { describe, expect, it } from 'vitest';
import type { WindowId, WindowNode, WorkspaceId } from '@agentdeck/contracts';
import { createFakeApi } from '@agentdeck/fakes';
import { BoardController } from '../src/controller.ts';
import { decideDrop, dropTargetAt } from '../src/model/drop.ts';
import { menuItems, terminalItems } from '../src/react/BoardMenu.tsx';
import { createWindowRegistry } from '../src/registry.ts';

const A = 'ws-a' as WorkspaceId;
const B = 'ws-b' as WorkspaceId;
const node = (type: string, ws: WorkspaceId | null): WindowNode => ({
  id: 'w' as WindowId,
  type,
  workspaceId: ws,
  rect: { x: 0, y: 0, w: 10, h: 10 },
  z: 0,
  title: null,
  restoreRect: null,
  data: {},
});

describe('drop target (W5)', () => {
  const frames = [
    { workspaceId: A, rect: { x: 0, y: 0, w: 100, h: 100 }, z: 0 },
    { workspaceId: B, rect: { x: 50, y: 50, w: 100, h: 100 }, z: 1 },
  ];

  it('finds the top frame under the pointer, not counting the own frame', () => {
    expect(dropTargetAt({ x: 75, y: 75 }, frames, null)).toBe(B);
    expect(dropTargetAt({ x: 75, y: 75 }, frames, B)).toBe(A);
    expect(dropTargetAt({ x: 10, y: 10 }, frames, A)).toBeNull();
    expect(dropTargetAt({ x: 500, y: 500 }, frames, null)).toBeNull();
  });

  it('terminals spring back, other windows move', () => {
    expect(decideDrop(node('terminal', A), B)).toEqual({ kind: 'bounce', from: A, to: B });
    expect(decideDrop(node('terminal', null), B)).toEqual({ kind: 'bounce', from: null, to: B });
    expect(decideDrop(node('terminal', A), A)).toEqual({ kind: 'stay' });
    expect(decideDrop(node('terminal', A), null)).toEqual({ kind: 'stay' });
    expect(decideDrop(node('browser', A), B)).toEqual({ kind: 'adopt', workspaceId: B });
  });
});

describe('context menus (B3)', () => {
  it('New terminal lists installed agents by label with Shell last, and hides custom (IS-21)', () => {
    const caps = { hooks: false, resume: false, fork: false, askTool: false };
    const picked: string[] = [];
    const items = terminalItems(
      [
        { id: 'claude', label: 'Claude Code', installed: true, version: null, capabilities: { hooks: true, resume: true, fork: true, askTool: true } },
        { id: 'gemini', label: 'Gemini', installed: false, version: null, capabilities: caps },
        { id: 'omp', label: 'Oh My Pi', installed: true, version: '18.0.4', capabilities: caps },
        { id: 'shell', label: 'Shell', installed: true, version: null, capabilities: caps },
        { id: 'custom', label: 'Custom command', installed: true, version: null, capabilities: caps },
      ],
      (agent) => picked.push(agent),
    );
    expect(items.map((i) => (i.type === 'separator' ? '-' : i.label))).toEqual(['Claude Code', 'Oh My Pi', '-', 'Shell']);
    const omp = items[1]!;
    if (omp.type !== 'separator') omp.onSelect?.();
    expect(picked).toEqual(['omp']);
  });

  it('New terminal says so when nothing can be started', () => {
    const caps = { hooks: false, resume: false, fork: false, askTool: false };
    const items = terminalItems([{ id: 'custom', label: 'Custom command', installed: true, version: null, capabilities: caps }], () => {});
    expect(items.map((i) => (i.type === 'separator' ? '-' : i.label))).toEqual(['No agents installed']);
  });

  it('blank board, frame title and window title menus', async () => {
    const c = new BoardController({ api: createFakeApi(), registry: createWindowRegistry() });
    await c.start();
    const labels = (target: Parameters<BoardController['openMenu']>[0]['target']) =>
      menuItems(c, { screen: { x: 0, y: 0 }, flow: { x: 0, y: 0 }, target }, { terminal: true, browser: true }).map((i) =>
        i.type === 'separator' ? '-' : i.label,
      );
    expect(labels({ kind: 'pane' })).toEqual(['New terminal', 'New browser', 'New workspace…', 'Add project…', '-', 'Show all']);
    expect(labels({ kind: 'frame-body', workspaceId: c.state.frames[0]!.workspaceId })[0]).toBe('New terminal');
    expect(labels({ kind: 'frame-title', workspaceId: c.state.frames[0]!.workspaceId })).toEqual([
      'New terminal',
      'New browser',
      '-',
      'Open in editor',
      'Reveal in Finder',
      'Copy path',
      '-',
      'Rename…',
      'Delete workspace…',
    ]);
    expect(labels({ kind: 'window', windowId: 'win-login-claude' as WindowId })).toEqual([
      'Rename…',
      'Maximize',
      '-',
      'Copy folder path',
      'Open in system terminal',
      'Open in another workspace',
      '-',
      'Close',
    ]);
    c.dispose();
  });
});
