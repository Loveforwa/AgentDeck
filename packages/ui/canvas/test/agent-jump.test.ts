// CO4（TC-148 的白板部分）：⌥⌘1–9 跳到 Agents 视图的第 n 行（顺序由组装方给的 agentOrder 决定）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalWindowData, WindowComponentProps, WindowId } from '@agentdeck/contracts';
import { createFakeApi, SAMPLE, type FakeApi } from '@agentdeck/fakes';
import { BoardController, type BoardControllerOptions } from '../src/controller.ts';
import { createWindowRegistry } from '../src/registry.ts';
import { jumpAgentRow, matchShortcut, resolveShortcut, type KeyLike } from '../src/model/shortcuts.ts';

const id = (s: string) => s as WindowId;
const Nothing = (_p: WindowComponentProps<any>) => null; // eslint-disable-line @typescript-eslint/no-explicit-any

let api: FakeApi;
let c: BoardController;

async function setup(opts: Partial<BoardControllerOptions> = {}) {
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
  c = new BoardController({ api, registry, homeDir: SAMPLE.home, autosaveMs: 0, ...opts });
  c.setPane({ w: 1200, h: 800 });
  await c.start();
}

afterEach(() => {
  c?.dispose();
  api?.dispose();
});

const key = (k: Partial<KeyLike>): KeyLike => ({ key: '', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true, ...k });

describe('⌥⌘1–9', () => {
  it('matches by the physical key (Option changes the character) and leaves ⌘1 alone', () => {
    expect(matchShortcut(key({ key: '£', code: 'Digit3' }))).toBe('jump-agent-3');
    expect(matchShortcut(key({ key: '1', code: 'Digit1' }))).toBe('jump-agent-1');
    expect(matchShortcut(key({ key: 'º', code: 'Digit0' }))).toBeNull();
    expect(matchShortcut(key({ key: '#', code: 'Digit3', shiftKey: true }))).toBeNull();
    expect(matchShortcut(key({ key: '1', code: 'Digit1', altKey: false }))).toBe('show-all');
    expect(matchShortcut(key({ key: '¡', code: 'Digit1', metaKey: false }))).toBeNull();
    expect(jumpAgentRow('jump-agent-9')).toBe(9);
    expect(jumpAgentRow('show-all')).toBeNull();
    // 终端聚焦时也处理（带 ⌘，不和终端抢）
    expect(resolveShortcut(key({ key: '£', code: 'Digit3' }), { windowFocused: true, inEditable: false })).toBe('jump-agent-3');
  });

  it('jumps to the n-th row of the order the assembler gives and focuses it', async () => {
    const agentOrder = vi.fn(() => [id('win-login-codex'), id('win-login-claude'), id('win-shop-claude')]);
    await setup({ agentOrder });

    expect(c.runShortcut('jump-agent-3')).toBe(true);
    expect(c.state.focusedId).toBe('win-shop-claude');
    expect(agentOrder).toHaveBeenCalledTimes(1);
    // 没有第 7 行：不动
    expect(c.runShortcut('jump-agent-7')).toBe(true);
    expect(c.state.focusedId).toBe('win-shop-claude');
  });

  it('does nothing without an Agents view', async () => {
    await setup();
    expect(c.runShortcut('jump-agent-1')).toBe(false);
    expect(c.state.focusedId).toBeNull();
  });
});
