import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { summaryText, Topbar, waitingText, workspaceText } from '../src/index.ts';
import css from '../src/topbar.css?raw';

/** 选择器列表里含 selector 的那几条规则的声明，拼在一起（jsdom 不加载 CSS，直接看源文件）。 */
function declarations(selector: string): string {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2] ?? '');
  }
  return out.join('\n');
}

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

  it('X3: "Approve all…" only while something waits for approval, no shortcut; click asks the board', () => {
    const onApproveAll = vi.fn();
    const { rerender } = render(<Topbar {...base} waiting={1} approvable={0} onApproveAll={onApproveAll} />);
    expect(screen.queryByRole('button', { name: 'Approve all…' })).toBeNull();
    rerender(<Topbar {...base} waiting={2} approvable={1} onApproveAll={onApproveAll} />);
    const btn = screen.getByRole('button', { name: 'Approve all…' });
    expect(btn.getAttribute('title')).toBe('Review and approve 1 waiting permission request');
    // 紧跟在 waiting 后面，齿轮前面
    expect(btn.previousElementSibling?.className).toBe('ad-topbar-waiting');
    fireEvent.click(btn);
    expect(onApproveAll).toHaveBeenCalledTimes(1);
  });

  it('floats over the board (IS-63): the bar takes no pointer and is no drag region, its controls do and are no-drag', () => {
    const bar = declarations('.ad-topbar');
    expect(bar).toMatch(/pointer-events:\s*none/);
    expect(bar).not.toMatch(/-webkit-app-region/);
    // 拖动区由放顶栏的一方画（ui/canvas 的 .ad-workbench-drag），顶栏里一处 drag 都没有
    expect(css).not.toMatch(/-webkit-app-region:\s*drag/);
    for (const selector of ['.ad-topbar > :not(.ad-topbar-spacer)', '.ad-topbar button', ".ad-topbar [role='menu']"]) {
      const d = declarations(selector);
      expect(d, selector).toMatch(/pointer-events:\s*auto/);
      expect(d, selector).toMatch(/-webkit-app-region:\s*no-drag/);
    }
    // 空白（spacer）以外的每一项都被上面那条选中：按钮和数字都接指针
    render(<Topbar {...base} running={1} waiting={1} />);
    const items = [...document.querySelector('header.ad-topbar')!.children].filter((el) => el.matches(':not(.ad-topbar-spacer)'));
    expect(items.map((el) => el.className.split(' ')[0])).toEqual(['ad-button', 'ad-topbar-summary', 'ad-topbar-count', 'ad-topbar-waiting', 'ad-button']);
  });
});
