// 界面入口：注册两种窗口（终端、网页），取启动信息和主目录，建白板控制器，渲染顶栏 + 白板 + 源代码管理面板。
import '@agentdeck/design-tokens/fonts.css';
import '@agentdeck/ui-kit/base.css';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { needsYouOrder } from '@agentdeck/manager-panel';
import { BoardController } from '@agentdeck/ui-canvas';
import { registerWindow } from '@agentdeck/ui-canvas/registry';
import { browserWindowType } from '@agentdeck/ui-widget-browser';
import { registerTerminalWindow } from '@agentdeck/ui-widget-terminal';
import type { StartupInfo } from '../../shared/desktop-bridge.ts';
import { App } from './App.tsx';
import { installMenuShortcuts } from './menu-shortcuts.ts';

registerTerminalWindow();
registerWindow(browserWindowType);

const FALLBACK_STARTUP: StartupInfo = { warnings: [], tmuxError: null, demo: null, screenshot: false };

async function boot(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) throw new Error('#root not found');
  const api = window.agentdeck;
  const desktop = window.agentdeckDesktop;
  const [startup, homeDir] = await Promise.all([
    desktop?.startup().then((s) => s ?? FALLBACK_STARTUP) ?? Promise.resolve(FALLBACK_STARTUP),
    api.app.homeDir(),
  ]);
  // ⌥⌘1–9（CO4 / MP3）按左边管理面板 NEEDS YOU 一段的顺序跳
  const controller = new BoardController({ api, homeDir, agentOrder: needsYouOrder });
  // 退出前主进程调它把白板存掉（窗口销毁时 pagehide 来不及等保存完成）
  (window as Window & { __agentdeckFlush?: () => Promise<void> }).__agentdeckFlush = () => controller.flush();
  if (desktop) installMenuShortcuts(controller, desktop);
  // 开发时在控制台里看白板状态：__board.state（和 canvas 的 dev 页面一样）
  if ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV)(window as Window & { __board?: BoardController }).__board = controller;
  const loaded = controller.start();
  createRoot(root).render(
    <StrictMode>
      <App controller={controller} loaded={loaded} startup={startup} />
    </StrictMode>,
  );
}

void boot().catch((err: unknown) => console.error('[agentdeck] boot failed', err));
