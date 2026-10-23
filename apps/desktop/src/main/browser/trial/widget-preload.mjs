// widget.ts 试验窗口的 preload：把真的 BrowserService 以 window.agentdeckTrial.browser 交给 dev 页面。
// 只给试验用，不是应用的 preload（应用走 src/preload 和 window.agentdeck）。
import { contextBridge, ipcRenderer } from 'electron';

const call =
  (method) =>
  (...args) =>
    ipcRenderer.invoke('agentdeck-trial:browser', method, args);

contextBridge.exposeInMainWorld('agentdeckTrial', {
  browser: {
    prepare: call('prepare'),
    fileUrl: call('fileUrl'),
    openExternal: call('openExternal'),
    ping: call('ping'),
  },
});
