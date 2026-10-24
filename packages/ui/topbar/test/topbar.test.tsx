import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { summaryText, Topbar, waitingText, workspaceText } from '../src/index.ts';

const base = { workspaces: 2, windows: 5, running: 0, waiting: 0, projectsMenu: [] } as const;

describe('Topbar', () => {
  it('summary text pluralizes', () => {
    expect(summaryText(2, 5)).toBe('2 workspaces · 5 windows');
    expect(summaryText(1, 1)).toBe('1 workspace · 1 window');
    expect(summaryText(0, 0)).toBe('0 workspaces · 0 windows');
    expect(workspaceText({ label: 'main', windows: 3 })).toBe('main · 3 windows');
    expect(workspaceText({ label: 'feat/login', windows: 1 })).toBe('feat/login · 1 window');
  });

  it('one row (MVP v2 · V1): project menu and workspace text on the left, lamps and the gear on the right', () => {
    render(<Topbar {...base} running={2} waiting={1} waitingPosition={1} projectName="agentdeck" workspace={{ label: 'main', windows: 3 }} />);
    const bar = document.querySelector('header.ad-topbar')!;
    // 项目菜单按钮、当前工作区、空白、running、waiting、齿轮（没有文字）
    const texts = [...bar.children].map((el) => el.textContent).filter(Boolean);
    expect(texts).toEqual(['agentdeck', 'main · 3 windows', '2 running', '1/1 waiting']);
    const project = screen.getByRole('button', { name: 'agentdeck' });
    expect(project.getAttribute('aria-haspopup')).toBe('menu');
    expect(bar.firstElementChild).toBe(project);
    expect(bar.lastElementChild).toBe(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.queryByText('My Board')).toBeNull();
  });

  it('nothing focused: "My Board" and the whole board count', () => {
    render(<Topbar {...base} projectName={null} workspace={null} />);
    expect(screen.getByRole('button', { name: 'My Board' })).toBeTruthy();
    expect(screen.getByText('2 workspaces · 5 windows')).toBeTruthy();
  });

  it('Settings is a gear icon button with a tooltip, no text', () => {
    const onSettings = vi.fn();
    render(<Topbar {...base} onSettings={onSettings} />);
    const gear = screen.getByRole('button', { name: 'Settings' });
    expect(gear.textContent).toBe('');
    expect(gear.getAttribute('title')).toBe('Settings (⌘,)');
    expect(gear.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    fireEvent.click(gear);
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('leaves room for the macOS traffic lights only when asked', () => {
    const { rerender } = render(<Topbar {...base} />);
    const bar = () => document.querySelector('.ad-topbar')!;
    expect(bar().classList.contains('ad-topbar--traffic-lights')).toBe(false);
    rerender(<Topbar {...base} trafficLights />);
    expect(bar().classList.contains('ad-topbar--traffic-lights')).toBe(true);
  });

  it('status lamps: a green dot before running, a yellow one before waiting (MVP v2 · V2)', () => {
    render(<Topbar {...base} running={1} waiting={1} />);
    const running = screen.getByText('1 running');
    expect(running.className).toContain('ad-topbar-count--running');
    expect(running.querySelector('.ad-topbar-lamp')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 waiting' }).querySelector('.ad-topbar-lamp--waiting')).toBeTruthy();
  });

  it('hides zero running / waiting', () => {
    const { rerender } = render(<Topbar {...base} running={3} waiting={1} />);
    expect(screen.getByText('3 running')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 waiting' })).toBeTruthy();
    rerender(<Topbar {...base} />);
    expect(screen.queryByText(/running/)).toBeNull();
    expect(screen.queryByText(/waiting/)).toBeNull();
  });

  it('shows the focused window position among the waiting ones', () => {
    expect(waitingText(3)).toBe('3 waiting');
    expect(waitingText(3, 2)).toBe('2/3 waiting');
    expect(waitingText(1, 1)).toBe('1/1 waiting');
    expect(waitingText(2, 5)).toBe('2 waiting');
    render(<Topbar {...base} waiting={3} waitingPosition={2} />);
    expect(screen.getByRole('button', { name: '2/3 waiting' })).toBeTruthy();
  });

  it('waiting button and the project menu', () => {
    const onWaiting = vi.fn();
    const onNew = vi.fn();
    render(
      <Topbar
        {...base}
        waiting={2}
        onWaitingClick={onWaiting}
        projectsMenu={[{ id: 'p', label: 'agentdeck', items: [{ id: 'new', label: 'New workspace…', onSelect: onNew }] }, { id: 'add', label: 'Add project…' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '2 waiting' }));
    expect(onWaiting).toHaveBeenCalled();
    const project = screen.getByRole('button', { name: 'My Board' });
    fireEvent.click(project);
    expect(project.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /agentdeck/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Add project/ })).toBeTruthy();
  });
});
