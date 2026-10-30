import { describe, expect, it } from 'vitest';
import { fixedWindowSize, mainWindowOptions, TOPBAR_HEIGHT, TRAFFIC_LIGHT_POSITION, usesInsetTitleBar } from '../src/main/window-options.ts';

describe('main window options (MVP v2 · V1)', () => {
  it('macOS: hiddenInset title bar, traffic lights centred in the 34px top bar', () => {
    const o = mainWindowOptions('darwin', '/x/preload/index.cjs');
    expect(o.titleBarStyle).toBe('hiddenInset');
    expect(o.trafficLightPosition).toEqual(TRAFFIC_LIGHT_POSITION);
    expect(TOPBAR_HEIGHT).toBe(34);
    // 按钮那一排高 16：上下各留 9
    expect(TRAFFIC_LIGHT_POSITION.y * 2 + 16).toBe(TOPBAR_HEIGHT);
    // 顶栏左边留的 76px 装得下三个按钮
    expect(TRAFFIC_LIGHT_POSITION.x + 54).toBeLessThanOrEqual(76);
    expect(usesInsetTitleBar('darwin')).toBe(true);
  });

  it('other platforms keep the system title bar', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const o = mainWindowOptions(platform, '/x/preload/index.cjs');
      expect(o.titleBarStyle).toBeUndefined();
      expect(o.trafficLightPosition).toBeUndefined();
      expect(usesInsetTitleBar(platform)).toBe(false);
    }
  });

  it('keeps the security settings and the preload path', () => {
    const o = mainWindowOptions('darwin', '/x/preload/index.cjs');
    expect(o.webPreferences).toMatchObject({
      preload: '/x/preload/index.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
    });
    expect(o).toMatchObject({ width: 1440, height: 900, minWidth: 720, minHeight: 480, show: false, title: 'AgentDeck' });
  });

  it('AGENTDECK_WINDOW_SIZE fixes the size and lets the window be larger than the screen (e2e on small CI screens)', () => {
    expect(fixedWindowSize('1440x900')).toEqual({ width: 1440, height: 900 });
    for (const bad of [undefined, '', '1440', '1440×900', 'axb', '10x10']) expect(fixedWindowSize(bad)).toBeNull();
    const o = mainWindowOptions('darwin', '/x/preload/index.cjs', { width: 1600, height: 1000 });
    expect(o).toMatchObject({ width: 1600, height: 1000, enableLargerThanScreen: true });
    expect(mainWindowOptions('darwin', '/x/preload/index.cjs').enableLargerThanScreen).toBeUndefined();
  });
});
