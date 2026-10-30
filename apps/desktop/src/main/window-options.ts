// 主窗口的选项（纯逻辑，测试里直接调）。MVP v2 · V1：macOS 上系统标题栏和顶栏合成一行。

import type { BrowserWindowConstructorOptions } from 'electron';

/** 顶栏高度，和 packages/ui/topbar/src/topbar.css 的 .ad-topbar 一致。 */
export const TOPBAR_HEIGHT = 34;

/**
 * macOS 红黄绿按钮那一排的高度（每个按钮的视图 14×16，圆点 12）。trafficLightPosition 定的是这一排左上角，
 * 竖直方向居中：(34 − 16) / 2 = 9。顶栏左边留的 76px 盖得住 x + 三个按钮（约 14 + 54）。
 */
const TRAFFIC_LIGHTS_HEIGHT = 16;

export const TRAFFIC_LIGHT_POSITION = { x: 14, y: Math.round((TOPBAR_HEIGHT - TRAFFIC_LIGHTS_HEIGHT) / 2) } as const;

/** 这个平台上顶栏是不是和系统标题栏合成一行（界面据此给红黄绿按钮留位置）。 */
export function usesInsetTitleBar(platform: NodeJS.Platform): boolean {
  return platform === 'darwin';
}

/**
 * AGENTDECK_WINDOW_SIZE=1440x900：窗口固定这么大，屏幕更小也不缩（只给 e2e 用）。GitHub 的 macOS 机器屏幕只有 1024×768，
 * macOS 默认把窗口高度压到屏幕里，白板一小，源代码管理面板就盖住了别的窗口，测试点不到。格式不对时返回 null。
 */
export function fixedWindowSize(value: string | undefined): { width: number; height: number } | null {
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(value?.trim() ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

export function mainWindowOptions(
  platform: NodeJS.Platform,
  preload: string,
  fixedSize: { width: number; height: number } | null = null,
): BrowserWindowConstructorOptions {
  return {
    width: fixedSize?.width ?? 1440,
    height: fixedSize?.height ?? 900,
    // 只有 macOS 认这一项（其他平台本来就不压）
    ...(fixedSize ? { enableLargerThanScreen: true } : {}),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'AgentDeck',
    // 其他平台保留系统标题栏（hidden 在 Linux / Windows 上会连窗口按钮一起去掉）
    ...(usesInsetTitleBar(platform) ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION } } : {}),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 网页窗口的 webview 模式（外部网站，IS-44）；挂上去的 webview 由 browser/index.ts 锁住
      webviewTag: true,
    },
  };
}
