import { describe, expect, it } from 'vitest';
import {
  WEB_PARTITION,
  browserUserAgent,
  guestShortcut,
  lockDownWebview,
  popupAllowed,
  type GuestPreferences,
} from '../../src/main/browser/webview.ts';

describe('lockDownWebview (IS-44)', () => {
  it('strips preload and node, forces isolation and sandbox', () => {
    const prefs: GuestPreferences = { preload: '/evil.js', nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false };
    expect(lockDownWebview(prefs, { src: 'https://www.google.com/', partition: WEB_PARTITION })).toBe(true);
    expect(prefs).toEqual({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });

  it('only our partition and http(s) addresses', () => {
    expect(lockDownWebview({}, { src: 'https://github.com/', partition: 'persist:other' })).toBe(false);
    expect(lockDownWebview({}, { src: 'https://github.com/' })).toBe(false);
    expect(lockDownWebview({}, { src: 'file:///etc/passwd', partition: WEB_PARTITION })).toBe(false);
    expect(lockDownWebview({}, { src: 'agentdeck-file:///tmp/a.html', partition: WEB_PARTITION })).toBe(false);
  });
});

describe('browserUserAgent', () => {
  it('drops Electron and the app name, keeps Chrome', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @agentdeck/desktop/0.1.0 Chrome/140.0.7339.41 Electron/45.0.0 Safari/537.36';
    expect(browserUserAgent(ua, '@agentdeck/desktop')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.41 Safari/537.36',
    );
    expect(browserUserAgent(ua.replace('@agentdeck/desktop', 'AgentDeck'), 'AgentDeck')).not.toMatch(/AgentDeck|Electron/);
  });
});

describe('guestShortcut', () => {
  const key = (k: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}) => ({
    type: 'keyDown',
    key: k,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods,
  });
  it('⌘[ ⌘] ⌘R on mac, Ctrl elsewhere', () => {
    expect(guestShortcut(key('[', { meta: true }), true)).toBe('back');
    expect(guestShortcut(key(']', { meta: true }), true)).toBe('forward');
    expect(guestShortcut(key('R', { meta: true, shift: true }), true)).toBe('reload');
    expect(guestShortcut(key('[', { control: true }), false)).toBe('back');
  });
  it('leaves everything else to the page', () => {
    expect(guestShortcut(key('[', { control: true }), true)).toBeNull();
    expect(guestShortcut(key('c', { meta: true }), true)).toBeNull();
    expect(guestShortcut(key('[', { meta: true, alt: true }), true)).toBeNull();
    expect(guestShortcut({ ...key('r', { meta: true }), type: 'keyUp' }, true)).toBeNull();
  });
});

it('popups: http(s) only', () => {
  expect(popupAllowed('https://accounts.google.com/o/oauth2/auth?x=1')).toBe(true);
  expect(popupAllowed('javascript:alert(1)')).toBe(false);
  expect(popupAllowed('file:///etc/passwd')).toBe(false);
});
