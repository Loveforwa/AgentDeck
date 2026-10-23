// 网页窗口在主进程里需要的配合。需求见「7 · 网页窗口」。
// 实现：apps/desktop 主进程里的 browser 模块（线 5）。界面：packages/ui/widgets/browser（线 5）。

import type { AbsPath } from './common.ts';

/** 本地 HTML 文件通过这个协议打开，例如 agentdeck-file:///Users/me/report.html。 */
export const LOCAL_FILE_SCHEME = 'agentdeck-file';

export interface PreparedPage {
  /** 给 iframe 的 src。localhost 原样返回；本地文件换成 LOCAL_FILE_SCHEME。 */
  src: string;
  mode: 'frame' | 'webview';
}

export interface BrowserService {
  /**
   * 打开前调用：localhost 的来源会被加进响应头改写名单（去掉 X-Frame-Options 和 frame-ancestors），
   * 本地文件会映射到 LOCAL_FILE_SCHEME。
   */
  prepare(url: string): Promise<PreparedPage>;
  /** 本地文件路径转成可打开的地址。 */
  fileUrl(path: AbsPath): Promise<string>;
  openExternal(url: string): Promise<void>;
  /** 判断服务是否在响应，出错页的 Retry 用。 */
  ping(url: string): Promise<{ ok: boolean; status: number | null }>;
}
