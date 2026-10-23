import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { summaryText, Topbar } from '../src/index.ts';

describe('Topbar', () => {
  it('summary text pluralizes', () => {
    expect(summaryText(2, 4)).toBe('2 workspaces · 4 terminals');
    expect(summaryText(1, 1)).toBe('1 workspace · 1 terminal');
    expect(summaryText(0, 0)).toBe('0 workspaces · 0 terminals');
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
