// 和 iframe 里小桥脚本之间的 postMessage 约定。
// 脚本由主进程注入（apps/desktop/src/main/browser/bridge.ts），两边的常量和消息形状要同步改。
// 没有小桥（例如在普通浏览器里跑 dev 页面）时网页窗口照样能用，只是地址栏跟不上 iframe 里的跳转。

/** iframe 的 name 前缀，主进程只往带这个前缀的 iframe 里注入。 */
export const BOARD_FRAME_NAME_PREFIX = 'agentdeck-browser:';
export const FRAME_SOURCE = 'agentdeck-frame';
export const BOARD_SOURCE = 'agentdeck-board';

/** 加载失败时 iframe 里是 Chromium 的出错页，小桥报上来的地址以它开头。 */
export const ERROR_PAGE_PREFIX = 'chrome-error:';

export type FrameKey = 'back' | 'forward' | 'reload' | 'address';

export type FrameMessage =
  | { type: 'location'; href: string; title: string; canGoBack: boolean; canGoForward: boolean }
  | { type: 'key'; key: FrameKey };

export type BoardCommand = 'back' | 'forward' | 'reload' | 'hello';

const KEYS: readonly string[] = ['back', 'forward', 'reload', 'address'];

/** 校验 iframe 发来的消息；不是小桥的消息返回 null。 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m['source'] !== FRAME_SOURCE) return null;
  if (m['type'] === 'location' && typeof m['href'] === 'string') {
    return {
      type: 'location',
      href: m['href'],
      title: typeof m['title'] === 'string' ? m['title'] : '',
      canGoBack: m['canGoBack'] === true,
      canGoForward: m['canGoForward'] === true,
    };
  }
  if (m['type'] === 'key' && typeof m['key'] === 'string' && KEYS.includes(m['key'])) {
    return { type: 'key', key: m['key'] as FrameKey };
  }
  return null;
}

export function boardCommand(type: BoardCommand): { source: string; type: BoardCommand } {
  return { source: BOARD_SOURCE, type };
}
