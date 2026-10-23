import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, Dialog, DialogText, RadioGroup } from '../src/index.ts';

const focused = () => document.activeElement as HTMLElement;

function DeleteWorkspace({ onClose = () => {}, withRadios = false }: { onClose?: () => void; withRadios?: boolean }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'remove' | 'delete'>('remove');
  const close = () => {
    onClose();
    setOpen(false);
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>Delete…</Button>
      <Dialog
        open={open}
        onClose={close}
        title="Delete workspace api-server · feat/oauth"
        actions={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={close}>
              Delete
            </Button>
          </>
        }
      >
        <DialogText tone="muted">claude and zsh will be stopped</DialogText>
        {withRadios && (
          <RadioGroup
            aria-label="Mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'remove', label: 'Remove from board', description: 'Keeps the folder and branch' },
              { value: 'delete', label: 'Also delete the worktree folder' },
            ]}
          />
        )}
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('renders nothing when closed', () => {
    render(<Dialog open={false} onClose={() => {}} title="Hidden" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a labelled modal dialog', async () => {
    const user = userEvent.setup();
    render(<DeleteWorkspace />);
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete workspace api-server · feat/oauth' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('Escape calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DeleteWorkspace onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('focuses the first button (Cancel) when the body has no fields', async () => {
    const user = userEvent.setup();
    render(<DeleteWorkspace />);
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(focused()).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('focuses the first field in the body when there is one', async () => {
    const user = userEvent.setup();
    render(<DeleteWorkspace withRadios />);
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(focused()).toBe(screen.getByRole('radio', { name: /Remove from board/ }));
  });

  it('honours initialFocus', async () => {
    function WithInitial() {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <Dialog
          open
          onClose={() => {}}
          title="Rename"
          initialFocus={ref}
          actions={
            <>
              <Button>Cancel</Button>
              <Button ref={ref} variant="primary">
                Save
              </Button>
            </>
          }
        />
      );
    }
    render(<WithInitial />);
    expect(focused()).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  it('keeps Tab inside the dialog in both directions', async () => {
    const user = userEvent.setup();
    render(<DeleteWorkspace withRadios />);
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    const radio = screen.getByRole('radio', { name: /Remove from board/ });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const del = screen.getByRole('button', { name: 'Delete' });

    await user.tab();
    expect(focused()).toBe(cancel);
    await user.tab();
    expect(focused()).toBe(del);
    await user.tab();
    expect(focused()).toBe(radio);
    await user.tab({ shift: true });
    expect(focused()).toBe(del);
  });

  it('arrow keys move between radio options', async () => {
    const user = userEvent.setup();
    render(<DeleteWorkspace withRadios />);
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    await user.keyboard('{ArrowDown}');
    expect((screen.getByRole('radio', { name: /Also delete/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('returns focus to the opener after closing', async () => {
    const user = userEvent.setup();
    render(<DeleteWorkspace />);
    const opener = screen.getByRole('button', { name: 'Delete…' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(focused()).toBe(opener);
  });

  it('does not close on backdrop click unless asked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Dialog open onClose={onClose} title="T" />);
    const backdrop = document.querySelector('.ad-dialog-backdrop')!;
    await user.pointer({ keys: '[MouseLeft]', target: backdrop });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Dialog open onClose={onClose} title="T" closeOnBackdrop />);
    await user.pointer({ keys: '[MouseLeft]', target: document.querySelector('.ad-dialog-backdrop')! });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
