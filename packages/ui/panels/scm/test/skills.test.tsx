// SKILLS · MCP 小节（N9）：列出、勾选（存进白板的回调）、Changes apply after restart、Restart and resume、折起来、
// 不支持的 agent、Add skill… / Add MCP…。数据来自 tools/fakes 的 FakeSkillsService（SAMPLE 里预置了库和 repo skill）。

import { useState } from 'react';
import type { AgentKind, SkillItemId, TerminalId } from '@agentdeck/contracts';
import { SAMPLE, createFakeApi, type FakeApi } from '@agentdeck/fakes';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScmPanel, type SkillsTarget } from '../src/index.ts';
import { mcpTarget, restartNeeded, skillRows, toggleSkill } from '../src/skills-model.ts';

const T = SAMPLE.terminals;
const W = SAMPLE.workspaces;

beforeEach(() => {
  localStorage.clear();
});

/** 像白板一样：选择存在自己的状态里，onChange 改它。 */
function Harness(props: { api: FakeApi; terminalId: TerminalId | null; agent?: AgentKind; initial?: SkillItemId[] | null; onRestart?: () => void; onChange?: (s: SkillItemId[]) => void }) {
  const [selection, setSelection] = useState<SkillItemId[] | null>(props.initial ?? null);
  const target: SkillsTarget = {
    terminalId: props.terminalId,
    agent: props.agent ?? 'claude',
    label: `${props.agent ?? 'claude'} · Fix the login bug`,
    selection,
    onChange: (s) => {
      props.onChange?.(s);
      setSelection(s);
    },
    onRestart: props.onRestart ?? (() => {}),
  };
  return <ScmPanel api={props.api} workspaceId={W.agentdeckLogin} skills={target} />;
}

const section = () => screen.getByRole('region', { name: 'Skills and MCP' });
const box = (name: string) => within(section()).getByRole('checkbox', { name }) as HTMLInputElement;

describe('SKILLS · MCP section', () => {
  it('is not there unless the board passes a target', async () => {
    const api = createFakeApi();
    render(<ScmPanel api={api} workspaceId={W.agentdeckLogin} />);
    await screen.findByRole('button', { name: /Commit/ });
    expect(screen.queryByRole('region', { name: 'Skills and MCP' })).toBeNull();
  });

  it('says what to do when the focused window isn’t a terminal', () => {
    render(<ScmPanel api={createFakeApi()} workspaceId={W.agentdeckLogin} skills={null} />);
    expect(within(section()).getByText('Focus a terminal to choose its skills and MCP servers.')).toBeTruthy();
  });

  it('lists built in, repo and library skills and MCP servers for the focused claude', async () => {
    const api = createFakeApi();
    render(<Harness api={api} terminalId={T.loginClaude} />);
    await within(section()).findByRole('checkbox', { name: 'xlsx' });
    expect(within(section()).getByText('for claude · Fix the login bug')).toBeTruthy();
    const rows = within(section()).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      'agentdeckbuilt in',
      'release-notesrepo',
      'xlsxlibrary',
      'agentdeckMCPbuilt in',
      'githubMCPlibrary',
    ]);
    expect(box('agentdeck').checked).toBe(true);
    expect(box('release-notes')).toMatchObject({ checked: true, disabled: true });
    expect(box('xlsx').checked).toBe(false);
    expect(box('agentdeck MCP').checked).toBe(true);
    expect(box('github MCP').checked).toBe(false);
    expect(within(section()).getByLabelText('Connected')).toBeTruthy();
    expect(rows[1]!.getAttribute('title')).toContain('Follows the repo');
    // 带的就是默认：不提示重启
    expect(within(section()).queryByText('Changes apply after restart')).toBeNull();
  });

  it('ticking saves the selection, shows “Changes apply after restart”, and Restart and resume restarts', async () => {
    const api = createFakeApi();
    const onChange = vi.fn();
    const onRestart = vi.fn();
    render(<Harness api={api} terminalId={T.loginClaude} onChange={onChange} onRestart={onRestart} />);
    await userEvent.click(await within(section()).findByRole('checkbox', { name: 'xlsx' }));
    expect(onChange).toHaveBeenLastCalledWith(['skill:built-in:agentdeck', 'skill:library:xlsx', 'mcp:built-in:agentdeck']);
    expect(box('xlsx').checked).toBe(true);
    expect(within(section()).getByText('Changes apply after restart')).toBeTruthy();
    await userEvent.click(box('agentdeck MCP'));
    expect(onChange).toHaveBeenLastCalledWith(['skill:built-in:agentdeck', 'skill:library:xlsx']);
    await userEvent.click(within(section()).getByRole('button', { name: 'Restart and resume' }));
    expect(onRestart).toHaveBeenCalledTimes(1);
    // 改回和启动时一样：提示消失
    await userEvent.click(box('xlsx'));
    await userEvent.click(box('agentdeck MCP'));
    expect(within(section()).queryByText('Changes apply after restart')).toBeNull();
  });

  it('after a restart (new terminal id, running = the new set) the note goes away', async () => {
    const api = createFakeApi();
    const selection = ['skill:built-in:agentdeck', 'skill:library:xlsx', 'mcp:built-in:agentdeck'];
    const { rerender } = render(<Harness api={api} terminalId={T.loginClaude} initial={selection} />);
    expect(await within(section()).findByText('Changes apply after restart')).toBeTruthy();
    api.fakes.skills.setRunning(T.shopClaude, selection);
    rerender(<Harness api={api} terminalId={T.shopClaude} initial={selection} />);
    await waitFor(() => expect(within(section()).queryByText('Changes apply after restart')).toBeNull());
  });

  it('collapses and remembers it', async () => {
    const api = createFakeApi();
    const { unmount } = render(<Harness api={api} terminalId={T.loginClaude} />);
    await within(section()).findByRole('checkbox', { name: 'xlsx' });
    const head = within(section()).getByRole('button', { name: /Skills · MCP/ });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(within(section()).queryByRole('checkbox')).toBeNull();
    expect(within(section()).queryByRole('button', { name: 'Add skill…' })).toBeNull();
    unmount();
    render(<Harness api={api} terminalId={T.loginClaude} />);
    expect(within(section()).getByRole('button', { name: /Skills · MCP/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('codex: skills can’t be ticked (Not supported for codex), MCP can', async () => {
    const api = createFakeApi();
    render(<Harness api={api} terminalId={T.loginCodex} agent="codex" />);
    await within(section()).findByRole('checkbox', { name: 'xlsx' });
    expect(box('xlsx').disabled).toBe(true);
    expect(box('agentdeck').disabled).toBe(true);
    expect(within(section()).getAllByText('Not supported for codex')).toHaveLength(2);
    expect(box('github MCP').disabled).toBe(false);
  });

  it('a shell has nothing to choose; a terminal that isn’t running says so', async () => {
    const api = createFakeApi();
    const { rerender } = render(<Harness api={api} terminalId={T.devServer} agent="shell" />);
    expect(await within(section()).findByText('Skills and MCP servers are for agents, not for shell.')).toBeTruthy();
    rerender(<Harness api={api} terminalId={null} />);
    expect(await within(section()).findByText('Start the terminal to choose its skills and MCP servers.')).toBeTruthy();
  });

  it('Add MCP… adds to the library and ticks it for this terminal', async () => {
    const api = createFakeApi();
    const onChange = vi.fn();
    render(<Harness api={api} terminalId={T.loginClaude} onChange={onChange} />);
    await userEvent.click(await within(section()).findByRole('button', { name: 'Add MCP…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add MCP server' });
    const add = within(dialog).getByRole('button', { name: 'Add' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText('Name'), 'docs');
    await userEvent.type(within(dialog).getByLabelText('Command or URL'), 'https://docs.example/mcp');
    await userEvent.click(add);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.fakes.skills.libraryItems.at(-1)).toMatchObject({ id: 'mcp:library:docs', detail: 'https://docs.example/mcp' });
    expect(box('docs MCP').checked).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(['skill:built-in:agentdeck', 'mcp:built-in:agentdeck', 'mcp:library:docs']);
  });

  it('Add MCP… shows the error (duplicate name) and stays open', async () => {
    const api = createFakeApi();
    render(<Harness api={api} terminalId={T.loginClaude} />);
    await userEvent.click(await within(section()).findByRole('button', { name: 'Add MCP…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add MCP server' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'github');
    await userEvent.type(within(dialog).getByLabelText('Command or URL'), 'npx gh');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(section()).findByText('An MCP server named github is already in the library')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Add MCP server' })).toBeTruthy();
  });

  it('Add skill… picks a folder, copies it into the library and ticks it', async () => {
    const api = createFakeApi();
    api.fakes.app.queuePickFolder('/Users/me/skills/pdf');
    render(<Harness api={api} terminalId={T.loginClaude} />);
    await userEvent.click(await within(section()).findByRole('button', { name: 'Add skill…' }));
    await waitFor(() => expect(box('pdf').checked).toBe(true));
    expect(api.fakes.skills.addedFolders).toEqual(['/Users/me/skills/pdf']);
    expect(within(section()).getByText('Changes apply after restart')).toBeTruthy();
  });

  it('Add skill… cancelled: nothing happens', async () => {
    const api = createFakeApi();
    api.fakes.app.queuePickFolder(null);
    render(<Harness api={api} terminalId={T.loginClaude} />);
    await userEvent.click(await within(section()).findByRole('button', { name: 'Add skill…' }));
    expect(api.fakes.skills.addedFolders).toEqual([]);
  });
});

describe('skills model', () => {
  const items = [
    { id: 'skill:built-in:agentdeck', kind: 'skill', name: 'agentdeck', description: null, source: 'built-in', path: '/b', detail: null, defaultOn: true, toggleable: true, note: null, status: null },
    { id: 'skill:repo:r', kind: 'skill', name: 'r', description: 'Release notes', source: 'repo', path: '/r', detail: null, defaultOn: true, toggleable: false, note: 'Follows the repo', status: null },
    { id: 'skill:library:x', kind: 'skill', name: 'x', description: null, source: 'library', path: '/x', detail: null, defaultOn: false, toggleable: false, note: 'Not supported for codex', status: null },
  ] as const;

  it('rows: repo always ticked and locked; unsupported shows the note instead of the source', () => {
    const rows = skillRows([...items], null);
    expect(rows.map((r) => [r.checked, r.disabled, r.aside])).toEqual([
      [true, false, 'built in'],
      [true, true, 'repo'],
      [false, true, 'Not supported for codex'],
    ]);
    expect(rows[1]!.title).toBe('Release notes\nFollows the repo\n/r');
  });

  it('toggle keeps only toggleable ids', () => {
    expect(toggleSkill([...items], null, 'skill:built-in:agentdeck', false)).toEqual([]);
    expect(toggleSkill([...items], [], 'skill:library:x', true)).toEqual([]);
  });

  it('restartNeeded and the MCP field', () => {
    expect(restartNeeded(null, null)).toBe(false);
    expect(restartNeeded({ terminalId: 't' as TerminalId, agent: 'claude', items: [...items], running: [] }, null)).toBe(true);
    expect(mcpTarget(' https://x/mcp ')).toEqual({ url: 'https://x/mcp' });
    expect(mcpTarget('npx -y x')).toEqual({ command: 'npx -y x' });
    expect(mcpTarget('  ')).toBeNull();
  });
});
