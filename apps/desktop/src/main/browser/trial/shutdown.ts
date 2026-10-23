// 试验脚本的收尾：正常退出，避免 Electron 在退出阶段崩溃（弹系统崩溃窗口）。
//
// 2026-10-23 risk3.ts 早期版本崩过三次（EXC_BREAKPOINT，栈顶 node::InternalCallbackScope::~InternalCallbackScope，
// 下面是 uv_timer 回调）：脚本没监听 window-all-closed，win.destroy() 关掉最后一个窗口时 Electron 按默认行为开始退出，
// 脚本却还在 await setTimeout、建新窗口，计时器回调落在 node 环境拆除的过程中。
// 所以：试验脚本一律监听 window-all-closed（关窗口不退出）；跑完先关窗口、等 webview 等 webContents 销毁、
// 关掉自己起的服务，再 app.quit()；出错也走同一条路。

import { app, BrowserWindow, webContents } from 'electron';

export function keepAliveWhenWindowsClose(): void {
  app.on('window-all-closed', () => {});
}

export async function shutdown(closers: (() => Promise<unknown> | unknown)[] = [], code = 0): Promise<void> {
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  // webview 的 webContents 跟着宿主窗口销毁，但是异步的；最多等 2 秒。
  const end = Date.now() + 2000;
  while (webContents.getAllWebContents().length > 0 && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const close of closers) {
    try {
      await close();
    } catch {
      // 收尾时的错误不影响退出
    }
  }
  process.exitCode = code;
  app.quit();
}

/** 跑 main；不管成功还是抛错都走 shutdown。 */
export function runTrial(main: () => Promise<(() => Promise<unknown> | unknown)[] | void>): void {
  keepAliveWhenWindowsClose();
  void app.whenReady().then(async () => {
    let closers: (() => Promise<unknown> | unknown)[] = [];
    let code = 0;
    try {
      closers = (await main()) ?? [];
    } catch (err) {
      console.error(err);
      code = 1;
    }
    await shutdown(closers, code);
  });
}
