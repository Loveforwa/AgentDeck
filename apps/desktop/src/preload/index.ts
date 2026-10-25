// preload：在沙箱里运行，只能用 electron 的 contextBridge / ipcRenderer / webUtils。
// 界面拿到 window.agentdeck（contracts 的 AgentDeckApi），另外两个应用壳自己的小接口：
//   window.agentdeckDesktop：启动信息、菜单快捷键、截图模式（src/shared/desktop-bridge.ts）
//   window.agentdeckFiles：拖进来的 File 换成路径（Electron 32 起 File 没有 path，终端窗口用）

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CONTRACTS_VERSION, FIRE_AND_FORGET, IPC, type AgentDeckEvent } from '@agentdeck/contracts';
import { SERVICE_METHODS } from '../shared/methods.ts';
import { DESKTOP_IPC, type DesktopBridge, type MenuShortcutId } from '../shared/desktop-bridge.ts';
import { installAgentDeckApi, type ApiManifest, type RawBridge } from './api.ts';

// 启动时向主进程要终端输出端口；主进程用 webContents.postMessage 把端口发回来。
const terminalPort = new Promise<MessagePort>((resolve) => {
  ipcRenderer.once(IPC.terminalPort, (event) => {
    const port = event.ports[0];
    if (port !== undefined) resolve(port);
  });
});
ipcRenderer.send(IPC.terminalPort);

const bridge: RawBridge = {
  invoke: (message) => ipcRenderer.invoke(IPC.invoke, message),
  send: (message) => ipcRenderer.send(IPC.send, message),
  onEvent: (listener) => {
    ipcRenderer.on(IPC.event, (_event, payload: AgentDeckEvent) => listener(payload));
  },
  onTerminalData: (listener) => {
    void terminalPort.then((port) => {
      port.addEventListener('message', (event) => listener(event.data));
      port.start();
    });
  },
};

const manifest: ApiManifest = {
  methods: SERVICE_METHODS,
  fireAndForget: FIRE_AND_FORGET,
  contractsVersion: CONTRACTS_VERSION,
};

// 见 api.ts 开头：在页面世界里构造 API，错误才能带着 code 抛给界面。
contextBridge.executeInMainWorld({ func: installAgentDeckApi, args: [bridge, manifest, true] });

const desktop: DesktopBridge = {
  startup: () => ipcRenderer.invoke(DESKTOP_IPC.startup),
  retryTmux: () => ipcRenderer.invoke(DESKTOP_IPC.retryTmux),
  openSettings: () => ipcRenderer.invoke(DESKTOP_IPC.openSettings),
  onNotice: (listener) => {
    ipcRenderer.on(DESKTOP_IPC.notice, (_event, message: string) => listener(message));
  },
  boardReady: (info) => ipcRenderer.send(DESKTOP_IPC.boardReady, info),
  onShortcut: (listener) => {
    ipcRenderer.on(DESKTOP_IPC.shortcut, (_event, id: MenuShortcutId) => listener(id));
  },
  nativeEdit: (action) => ipcRenderer.send(DESKTOP_IPC.nativeEdit, action),
};
contextBridge.exposeInMainWorld('agentdeckDesktop', desktop);
contextBridge.exposeInMainWorld('agentdeckFiles', { pathFor: (file: File) => webUtils.getPathForFile(file) });
