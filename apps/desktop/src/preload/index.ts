// preload：在沙箱里运行，只能用 electron 的 contextBridge / ipcRenderer。界面只能拿到 window.agentdeck。

import { contextBridge, ipcRenderer } from 'electron';
import { CONTRACTS_VERSION, FIRE_AND_FORGET, IPC, type AgentDeckEvent } from '@agentdeck/contracts';
import { SERVICE_METHODS } from '../shared/methods.ts';
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
