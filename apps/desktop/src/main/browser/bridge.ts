// 网页窗口的 iframe 和白板之间的小桥。
//
// 白板页面读不到跨源 iframe 的地址，也调不了它的 history，所以主进程在白板的 iframe 加载完后
// 往里面注入一小段脚本（WebFrameMain.executeJavaScript），由它通过 postMessage 告诉白板：
// 现在的地址、标题、能不能后退前进、页面里按了 ⌘[ ⌘] ⌘R ⌘L；白板再通过 postMessage 让它后退、前进、刷新。
// 加载失败时 iframe 里是 Chromium 的出错页，小桥同样会注入进去，报告的地址是 chrome-error://chromewebdata/，
// 界面据此再 ping 一次，决定显示“isn’t responding”还是“can’t be shown on the board”。
//
// 消息格式和 packages/ui/widgets/browser/src/bridge.ts 是同一份约定，两边改动要同步。
// 不放进 contracts：它不经过 IPC，只是白板页面和 iframe 之间的 postMessage。

/** 白板里网页窗口的 iframe 的 name 以它开头，主进程据此只往这些 iframe 里注入。 */
export const BOARD_FRAME_NAME_PREFIX = 'agentdeck-browser:';
/** iframe → 白板的消息带 source: FRAME_SOURCE；白板 → iframe 的带 source: BOARD_SOURCE。 */
export const FRAME_SOURCE = 'agentdeck-frame';
export const BOARD_SOURCE = 'agentdeck-board';

/** 注入到页面里的脚本。每个文档只装一次；只听父窗口（白板）的命令。 */
export const BRIDGE_SCRIPT = `(() => {
  if (window.__agentdeckBridge) return;
  window.__agentdeckBridge = true;
  const parent = window.parent;
  const nav = window.navigation;
  const post = (msg) => parent.postMessage(Object.assign({ source: ${JSON.stringify(FRAME_SOURCE)} }, msg), '*');
  let last = '';
  const report = (force) => {
    const msg = {
      type: 'location',
      href: location.href,
      title: document.title,
      canGoBack: nav ? nav.canGoBack : history.length > 1,
      canGoForward: nav ? nav.canGoForward : false,
    };
    const key = JSON.stringify(msg);
    if (key === last && force !== true) return;
    last = key;
    post(msg);
  };
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; report(); }, 50);
  };
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function (...args) {
      const result = original.apply(this, args);
      schedule();
      return result;
    };
  }
  addEventListener('popstate', schedule);
  addEventListener('hashchange', schedule);
  if (nav) nav.addEventListener('navigatesuccess', schedule);
  if (document.head) new MutationObserver(schedule).observe(document.head, { childList: true, subtree: true, characterData: true });
  addEventListener('keydown', (e) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return;
    const key = { '[': 'back', ']': 'forward', r: 'reload', l: 'address' }[e.key.toLowerCase()];
    if (!key) return;
    e.preventDefault();
    post({ type: 'key', key });
  }, true);
  addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || e.data.source !== ${JSON.stringify(BOARD_SOURCE)}) return;
    if (e.data.type === 'back') history.back();
    else if (e.data.type === 'forward') history.forward();
    else if (e.data.type === 'reload') location.reload();
    else if (e.data.type === 'hello') report(true);
  });
  report(true);
})();`;

/** 只往白板页面的直接子 iframe、且 name 带前缀的里面注入；页面自己再嵌的 iframe 不管。 */
export function isBoardFrame(frame: { name: string; parentIsBoard: boolean }): boolean {
  return frame.parentIsBoard && frame.name.startsWith(BOARD_FRAME_NAME_PREFIX);
}
