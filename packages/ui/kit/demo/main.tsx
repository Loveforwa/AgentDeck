// 零件演示页：每个零件的各种状态，亮色和暗色各一遍。下半部分的按钮可以真的打开浮层试键盘操作。
import '@agentdeck/design-tokens/fonts.css';
import '../src/base.css';
import './demo.css';

import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Button,
  Dialog,
  DialogPanel,
  DialogText,
  Menu,
  Popover,
  PopoverPanel,
  PortalProvider,
  RadioGroup,
  Toast,
  ToastProvider,
  useToast,
  type MenuEntry,
  type PopoverAnchor,
} from '../src/index.ts';

const boardMenu = (grid: boolean, setGrid: (v: boolean) => void): MenuEntry[] => [
  {
    id: 'new-terminal',
    label: 'New terminal',
    items: [
      { id: 'claude', label: 'claude', shortcut: '⌘N' },
      { id: 'codex', label: 'codex' },
      { type: 'separator' },
      { id: 'shell', label: 'Shell' },
    ],
  },
  { id: 'new-browser', label: 'New browser', shortcut: '⌘T' },
  { id: 'new-workspace', label: 'New workspace…', shortcut: '⌘⇧N' },
  { id: 'add-project', label: 'Add project…' },
  { type: 'separator' },
  { id: 'grid', label: 'Show grid', checked: grid, onSelect: () => setGrid(!grid) },
  { id: 'snap', label: 'Snap to frames', checked: false },
  { type: 'separator' },
  { id: 'show-all', label: 'Show all', shortcut: '⌘1' },
  { id: 'paste', label: 'Paste', shortcut: '⌘V', disabled: true },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="demo-section">
      <h2 className="demo-section-title">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="demo-row">
      <span className="demo-row-label">{label}</span>
      <div className="demo-row-items">{children}</div>
    </div>
  );
}

function DeleteBody({ mode, setMode }: { mode: 'remove' | 'delete'; setMode: (m: 'remove' | 'delete') => void }) {
  return (
    <>
      <DialogText tone="muted">claude and zsh will be stopped.</DialogText>
      <RadioGroup
        aria-label="How to delete"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'remove', label: 'Remove from board', description: 'Keeps the folder and branch' },
          { value: 'delete', label: 'Also delete the worktree folder', description: 'The branch stays' },
        ]}
      />
      {mode === 'delete' && <DialogText tone="attention">3 uncommitted changes will be lost.</DialogText>}
    </>
  );
}

function StaticParts() {
  const [grid, setGrid] = useState(true);
  const [mode, setMode] = useState<'remove' | 'delete'>('delete');
  return (
    <>
      <Section title="Button">
        <Row label="Default">
          <Button>Cancel</Button>
          <Button disabled>Cancel</Button>
          <Button size="sm">Discard</Button>
        </Row>
        <Row label="Primary">
          <Button variant="primary">Commit</Button>
          <Button variant="primary" disabled>
            Commit
          </Button>
          <Button variant="primary" size="sm">
            Stage all
          </Button>
        </Row>
        <Row label="Ghost">
          <Button variant="ghost">Open in system terminal</Button>
          <Button variant="ghost" disabled>
            Refresh
          </Button>
          <Button variant="ghost" size="sm" aria-label="More">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="3" cy="7" r="1.1" fill="currentColor" />
              <circle cx="7" cy="7" r="1.1" fill="currentColor" />
              <circle cx="11" cy="7" r="1.1" fill="currentColor" />
            </svg>
          </Button>
        </Row>
      </Section>

      <Section title="Menu">
        <div className="demo-menu-stage">
          <Menu
            items={boardMenu(grid, setGrid)}
            aria-label="Board"
            autoFocus={false}
            defaultOpenSubmenu="new-terminal"
          />
          <Menu
            items={[
              { id: 'rename', label: 'Rename…' },
              { id: 'focus', label: 'Focus', shortcut: '⌘J' },
              { type: 'separator' },
              { id: 'close', label: 'Close', shortcut: '⌘W' },
            ]}
            aria-label="Terminal"
            autoFocus={false}
            defaultActive="focus"
          />
        </div>
      </Section>

      <Section title="Dialog">
        <DialogPanel
          title="Delete workspace api-server · feat/oauth"
          width={380}
          actions={
            <>
              <Button>Cancel</Button>
              <Button variant="primary">Delete</Button>
            </>
          }
        >
          <DeleteBody mode={mode} setMode={setMode} />
        </DialogPanel>
      </Section>

      <Section title="Toast">
        <div className="demo-stack">
          <Toast message="Removed api-server · feat/oauth from the board" action={{ label: 'Undo', onAction: () => {} }} />
          <Toast message="Committed 2 files to feat/oauth" />
        </div>
      </Section>

      <Section title="Popover">
        <PopoverPanel>
          <div className="demo-popover-text">Stop claude and close this window?</div>
          <div className="ad-popover-actions">
            <Button size="sm">Cancel</Button>
            <Button size="sm" variant="primary">
              Stop
            </Button>
          </div>
        </PopoverPanel>
      </Section>
    </>
  );
}

function LiveParts() {
  const toast = useToast();
  const [menuAnchor, setMenuAnchor] = useState<PopoverAnchor>(null);
  const [popAnchor, setPopAnchor] = useState<HTMLElement | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<'remove' | 'delete'>('remove');
  const [grid, setGrid] = useState(true);
  const closeDialog = () => setDialogOpen(false);

  return (
    <Section title="Try it">
      <p className="demo-hint">Arrow keys, Enter, Esc and Tab work in every part. Right-click the area below for a context menu.</p>
      <div className="demo-row-items">
        <Button onClick={(e) => setMenuAnchor(e.currentTarget)} aria-haspopup="menu">
          Open menu
        </Button>
        <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
        <Button
          onClick={() =>
            toast.show({
              message: 'Removed api-server · feat/oauth from the board',
              action: { label: 'Undo', onAction: () => toast.show({ message: 'Restored api-server · feat/oauth' }) },
            })
          }
        >
          Show toast
        </Button>
        <Button onClick={(e) => setPopAnchor(e.currentTarget)}>Open popover</Button>
      </div>
      <div
        className="demo-context-area"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAnchor({ x: e.clientX, y: e.clientY });
        }}
      >
        Right-click here
      </div>

      <Popover open={!!menuAnchor} anchor={menuAnchor} chrome={false} onClose={() => setMenuAnchor(null)}>
        <Menu
          items={boardMenu(grid, setGrid)}
          aria-label="Board"
          defaultActive="first"
          onClose={() => setMenuAnchor(null)}
          onSelect={(item) => toast.show({ message: `Selected ${item.label}` })}
        />
      </Popover>

      <Popover open={!!popAnchor} anchor={popAnchor} onClose={() => setPopAnchor(null)} aria-label="Stop claude">
        <div className="demo-popover-text">Stop claude and close this window?</div>
        <div className="ad-popover-actions">
          <Button size="sm" onClick={() => setPopAnchor(null)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => setPopAnchor(null)}>
            Stop
          </Button>
        </div>
      </Popover>

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        title="Delete workspace api-server · feat/oauth"
        actions={
          <>
            <Button onClick={closeDialog}>Cancel</Button>
            <Button variant="primary" onClick={closeDialog}>
              Delete
            </Button>
          </>
        }
      >
        <DeleteBody mode={mode} setMode={setMode} />
      </Dialog>
    </Section>
  );
}

function ThemeColumn({ theme }: { theme: 'light' | 'dark' }) {
  // 浮层渲染到这一栏里面，才能用这一栏的主题。
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  return (
    <div className="demo-theme" data-theme={theme}>
      <div className="demo-theme-name">{theme === 'light' ? 'Light' : 'Dark'}</div>
      <PortalProvider container={layer}>
        <ToastProvider>
          <StaticParts />
          <LiveParts />
        </ToastProvider>
      </PortalProvider>
      <div ref={setLayer} />
    </div>
  );
}

function App() {
  return (
    <div className="demo">
      <header className="demo-header">
        <span className="demo-title">AgentDeck UI kit</span>
        <span className="demo-subtitle">@agentdeck/ui-kit · tokens from @agentdeck/design-tokens</span>
      </header>
      <main className="demo-columns">
        <ThemeColumn theme="light" />
        <ThemeColumn theme="dark" />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
