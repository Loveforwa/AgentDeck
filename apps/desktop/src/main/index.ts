// 主进程入口：建窗口、装 IPC、启动终端 utilityProcess、注册服务。

import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } from 'electron';
import type { MessagePortMain } from 'electron';
import echoHostPath from '../utility/echo-host.ts?modulePath';
import { registerDevServices } from './dev-services.ts';
import { startHostProcess } from './host-process.ts';
import { installIpc, type IpcMainLike } from './ipc.ts';
import { emit, registry } from './services.ts';
import { createTerminalPortBroker } from './terminal-ports.ts';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'AgentDeck',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win.show());

  // 应用页面不允许跳走或开新窗口；外部链接由 browser 服务处理。
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (!app.isPackaged) {
    // 开发时把界面的 console 打到终端，方便不开 DevTools 也能看到验证结果。
    win.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message}`);
    });
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl !== undefined) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

void app.whenReady().then(() => {
  const host = startHostProcess<MessagePortMain>({
    fork: () => utilityProcess.fork(echoHostPath, [], { serviceName: 'agentdeck-terminal-host' }),
    onExit: (code) => console.error(`[agentdeck] terminal host exited with code ${code}`),
  });
  const terminalPorts = createTerminalPortBroker<MessagePortMain>({
    createChannel: () => new MessageChannelMain(),
    sink: host,
  });
  installIpc({ ipcMain: ipcMain as unknown as IpcMainLike<MessagePortMain>, registry, terminalPorts });

  registerDevServices({
    registry,
    emit,
    host,
    setBadge: (count) => app.dock?.setBadge(count > 0 ? String(count) : ''),
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('will-quit', () => host.stop());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
