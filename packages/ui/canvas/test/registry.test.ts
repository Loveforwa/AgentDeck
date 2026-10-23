import { describe, expect, it, vi } from 'vitest';
import type { WindowComponentProps } from '@agentdeck/contracts';
import { createWindowRegistry, isSummarySize, type WindowDefinition } from '../src/registry.ts';

interface NoteData {
  text: string;
}

const Note = (_props: WindowComponentProps<NoteData>) => null;

const note = (patch: Partial<WindowDefinition<NoteData>> = {}): WindowDefinition<NoteData> => ({
  type: 'note',
  label: 'Note',
  defaultSize: { w: 400, h: 300 },
  minSize: { w: 200, h: 120 },
  summaryBelow: { w: 320, h: 200 },
  component: Note,
  create: (init) => ({ text: init.text ?? '' }),
  ...patch,
});

describe('window registry', () => {
  it('registers, looks up and lists in order', () => {
    const r = createWindowRegistry();
    r.register(note());
    r.register(note({ type: 'other', label: 'Other' }));
    expect(r.get('note')?.label).toBe('Note');
    expect(r.get('missing')).toBeUndefined();
    expect(r.list().map((d) => d.type)).toEqual(['note', 'other']);
    expect(r.get('note')?.create({})).toEqual({ text: '' });
  });

  it('replaces a type registered twice; the old unregister does nothing', () => {
    const r = createWindowRegistry();
    const off1 = r.register(note({ label: 'Old' }));
    const off2 = r.register(note({ label: 'New' }));
    expect(r.get('note')?.label).toBe('New');
    off1();
    expect(r.get('note')?.label).toBe('New');
    off2();
    expect(r.get('note')).toBeUndefined();
  });

  it('notifies subscribers and bumps the version', () => {
    const r = createWindowRegistry();
    const listener = vi.fn();
    const unsub = r.subscribe(listener);
    const v0 = r.version();
    const off = r.register(note());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(r.version()).toBeGreaterThan(v0);
    off();
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    r.register(note());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects bad sizes', () => {
    const r = createWindowRegistry();
    expect(() => r.register(note({ type: '' }))).toThrow(/type/);
    expect(() => r.register(note({ minSize: { w: 0, h: 10 } }))).toThrow(/minSize/);
    expect(() => r.register(note({ defaultSize: { w: 100, h: 100 } }))).toThrow(/smaller/);
  });

  it('summary when width or height is under summaryBelow', () => {
    const def = note();
    expect(isSummarySize(def, { w: 400, h: 300 })).toBe(false);
    expect(isSummarySize(def, { w: 319, h: 300 })).toBe(true);
    expect(isSummarySize(def, { w: 400, h: 199 })).toBe(true);
    expect(isSummarySize({}, { w: 10, h: 10 })).toBe(false);
  });
});
