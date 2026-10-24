import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { summaryText, Topbar, waitingText } from '../src/index.ts';

describe('Topbar', () => {
  it('summary text pluralizes', () => {
    expect(summaryText(2, 4)).toBe('2 workspaces · 4 terminals');
    expect(summaryText(1, 1)).toBe('1 workspace · 1 terminal');
    expect(summaryText(0, 0)).toBe('0 workspaces · 0 terminals');
  });

  it('status lamps: a green dot before running, a yellow one before waiting (MVP v2 · V2)', () => {
    render(<Topbar workspaces={1} terminals={2} running={1} waiting={1} projectsMenu={[]} />);
    const running = screen.getByText('1 running');
    expect(running.className).toContain('ad-topbar-count--running');
    expect(running.querySelector('.ad-topbar-lamp')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 waiting' }).querySelector('.ad-topbar-lamp--waiting')).toBeTruthy();
  });

  it('shows counts and hides zero running / waiting', () => {
    const { rerender } = render(<Topbar workspaces={2} terminals={4} running={3} waiting={1} projectsMenu={[]} />);
    expect(screen.getByText('My Board')).toBeTruthy();
    expect(screen.getByText('3 running')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 waiting' })).toBeTruthy();
    rerender(<Topbar workspaces={2} terminals={4} running={0} waiting={0} projectsMenu={[]} />);
    expect(screen.queryByText(/running/)).toBeNull();
    expect(screen.queryByText(/waiting/)).toBeNull();
  });

  it('shows the focused window position among the waiting ones', () => {
    expect(waitingText(3)).toBe('3 waiting');
    expect(waitingText(3, 2)).toBe('2/3 waiting');
    expect(waitingText(1, 1)).toBe('1/1 waiting');
    expect(waitingText(2, 5)).toBe('2 waiting');
    render(<Topbar workspaces={1} terminals={3} running={0} waiting={3} waitingPosition={2} projectsMenu={[]} />);
    expect(screen.getByRole('button', { name: '2/3 waiting' })).toBeTruthy();
  });

  it('waiting button and Projects menu', () => {
    const onWaiting = vi.fn();
    const onNew = vi.fn();
    render(
      <Topbar
        workspaces={1}
        terminals={1}
        running={0}
        waiting={2}
        onWaitingClick={onWaiting}
        projectsMenu={[{ id: 'p', label: 'agentdeck', items: [{ id: 'new', label: 'New workspace…', onSelect: onNew }] }, { id: 'add', label: 'Add project…' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '2 waiting' }));
    expect(onWaiting).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Projects/ }));
    expect(screen.getByRole('menuitem', { name: /agentdeck/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Add project/ })).toBeTruthy();
  });
});
