import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Menu, type MenuEntry } from '../src/index.ts';

const items: MenuEntry[] = [
  {
    id: 'new-terminal',
    label: 'New terminal',
    items: [
      { id: 'claude', label: 'claude' },
      { id: 'codex', label: 'codex' },
      { id: 'shell', label: 'Shell' },
    ],
  },
  { id: 'new-browser', label: 'New browser', shortcut: '⌘T' },
  { id: 'disabled', label: 'Duplicate', disabled: true },
  { type: 'separator' },
  { id: 'grid', label: 'Show grid', checked: true },
  { id: 'show-all', label: 'Show all', shortcut: '⌘1' },
];

const focused = () => document.activeElement as HTMLElement;

function setup(extra: Partial<Parameters<typeof Menu>[0]> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<Menu items={items} aria-label="Board" onSelect={onSelect} onClose={onClose} {...extra} />);
  return { user, onSelect, onClose };
}

describe('Menu keyboard', () => {
  it('focuses the menu itself on open, nothing highlighted', () => {
    setup();
    expect(focused()).toBe(screen.getByRole('menu', { name: 'Board' }));
  });

  it('ArrowDown walks enabled items, skipping disabled and separators, and wraps', async () => {
    const { user } = setup();
    await user.keyboard('{ArrowDown}');
    expect(focused()).toHaveProperty('textContent', 'New terminal');
    await user.keyboard('{ArrowDown}');
    expect(focused().textContent).toContain('New browser');
    await user.keyboard('{ArrowDown}');
    expect(focused().textContent).toContain('Show grid');
    await user.keyboard('{ArrowDown}');
    expect(focused().textContent).toContain('Show all');
    await user.keyboard('{ArrowDown}');
    expect(focused().textContent).toBe('New terminal');
  });

  it('ArrowUp from nothing goes to the last item; Home and End jump', async () => {
    const { user } = setup();
    await user.keyboard('{ArrowUp}');
    expect(focused().textContent).toContain('Show all');
    await user.keyboard('{Home}');
    expect(focused().textContent).toBe('New terminal');
    await user.keyboard('{End}');
    expect(focused().textContent).toContain('Show all');
    await user.keyboard('{ArrowUp}');
    expect(focused().textContent).toContain('Show grid');
  });

  it('marks the active item for styling and roving tabindex', async () => {
    const { user } = setup();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const browser = screen.getByRole('menuitem', { name: /New browser/ });
    expect(browser.getAttribute('data-active')).toBe('true');
    expect(browser.tabIndex).toBe(0);
    expect(screen.getByRole('menuitem', { name: /New terminal/ }).tabIndex).toBe(-1);
  });

  it('Enter selects a leaf item and closes the menu', async () => {
    const itemSelect = vi.fn();
    const custom: MenuEntry[] = [{ id: 'a', label: 'Alpha', onSelect: itemSelect }];
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Menu items={custom} onSelect={onSelect} onClose={onClose} />);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(itemSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Space also selects', async () => {
    const { user, onSelect } = setup();
    await user.keyboard('{End} ');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'show-all' }));
  });

  it('ArrowRight opens a submenu and focuses its first item; ArrowLeft returns to the parent', async () => {
    const { user, onClose } = setup();
    await user.keyboard('{ArrowDown}{ArrowRight}');
    const sub = screen.getByRole('menu', { name: 'New terminal' });
    expect(focused().textContent).toBe('claude');
    expect(sub.contains(focused())).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'New terminal' }).getAttribute('aria-expanded')).toBe('true');

    await user.keyboard('{ArrowDown}');
    expect(focused().textContent).toBe('codex');

    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('menu', { name: 'New terminal' })).toBeNull();
    expect(focused().textContent).toBe('New terminal');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Enter on a submenu parent opens it; Enter inside selects the sub item', async () => {
    const { user, onSelect, onClose } = setup();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(focused().textContent).toBe('claude');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape in a submenu closes only the submenu; Escape at the root closes the menu', async () => {
    const { user, onClose } = setup();
    await user.keyboard('{ArrowDown}{ArrowRight}');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'New terminal' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(focused().textContent).toBe('New terminal');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('typing a letter jumps to the next item starting with it', async () => {
    const { user } = setup();
    await user.keyboard('s');
    expect(focused().textContent).toContain('Show grid');
    await user.keyboard('s');
    expect(focused().textContent).toContain('Show all');
  });

  it('does not select disabled items', async () => {
    const { user, onSelect } = setup();
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('starts on the first item when opened from the keyboard', () => {
    setup({ defaultActive: 'first' });
    expect(focused().textContent).toBe('New terminal');
  });
});

describe('Menu rendering', () => {
  it('renders check items, shortcuts, separators and submenu arrows', () => {
    setup();
    const grid = screen.getByRole('menuitemcheckbox', { name: 'Show grid' });
    expect(grid.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(screen.getByText('⌘T').className).toBe('ad-menu-shortcut');
    const parent = screen.getByRole('menuitem', { name: 'New terminal' });
    expect(parent.getAttribute('aria-haspopup')).toBe('menu');
    expect(parent.querySelector('.ad-menu-arrow svg')).not.toBeNull();
  });

  it('opens a submenu on hover without stealing focus into it', async () => {
    const { user } = setup();
    const parent = screen.getByRole('menuitem', { name: 'New terminal' });
    await user.hover(parent);
    expect(screen.getByRole('menu', { name: 'New terminal' })).toBeTruthy();
    expect(focused()).toBe(parent);
    await user.hover(screen.getByRole('menuitem', { name: /New browser/ }));
    expect(screen.queryByRole('menu', { name: 'New terminal' })).toBeNull();
  });
});

describe('Menu headings and hints', () => {
  const grouped: MenuEntry[] = [
    { id: 'rename', label: 'Rename…' },
    { type: 'separator' },
    { type: 'heading', label: 'PLUGINS' },
    { id: 'auto', label: 'Auto-approve', checked: true },
    { id: 'usage', label: 'Usage', checked: false, disabled: true, hint: 'Not supported for kimi yet' },
    { type: 'separator' },
    { id: 'close', label: 'Close' },
  ];

  it('draws a heading that keyboard navigation skips, and a disabled item with its reason', async () => {
    const user = userEvent.setup();
    render(<Menu items={grouped} aria-label="Window" defaultActive="first" />);
    const heading = screen.getByText('PLUGINS');
    expect(heading.className).toBe('ad-menu-heading');
    expect(heading.getAttribute('role')).toBe('presentation');
    await user.keyboard('{ArrowDown}');
    expect(focused().textContent).toBe('Auto-approve');
    await user.keyboard('{ArrowDown}');
    expect(focused().textContent).toBe('Close');
    const usage = screen.getByRole('menuitemcheckbox', { name: /Usage/ });
    expect(usage.getAttribute('aria-disabled')).toBe('true');
    expect(usage.getAttribute('title')).toBe('Not supported for kimi yet');
    expect(usage.querySelector('.ad-menu-hint')?.textContent).toBe('Not supported for kimi yet');
  });
});

describe('Menu icons and mono labels (CO3)', () => {
  it('leaves an icon slot on every item of a level that has an icon, and sets mono labels in the mono face', () => {
    render(
      <Menu
        aria-label="Send selection to"
        items={[
          { type: 'heading', label: 'SHOP · FIX/CART' },
          { id: 'a', label: 'claude', mono: true, icon: <span data-testid="lamp" />, hint: 'sub-1 · api' },
          { type: 'separator' },
          { id: 'new', label: 'New terminal here…' },
        ]}
      />,
    );
    const a = screen.getByRole('menuitem', { name: /claude/ });
    expect(a.querySelector('.ad-menu-icon [data-testid="lamp"]')).not.toBeNull();
    expect(a.querySelector('.ad-menu-label')?.className).toContain('ad-menu-label--mono');
    const plain = screen.getByRole('menuitem', { name: 'New terminal here…' });
    expect(plain.querySelector('.ad-menu-icon')?.childElementCount).toBe(0);
    expect(plain.querySelector('.ad-menu-label')?.className).toBe('ad-menu-label');
  });

  it('draws no icon slot when nothing in the level has an icon', () => {
    render(<Menu aria-label="m" items={[{ id: 'x', label: 'Copy', shortcut: '⌘C' }]} />);
    expect(document.querySelector('.ad-menu-icon')).toBeNull();
  });
});
