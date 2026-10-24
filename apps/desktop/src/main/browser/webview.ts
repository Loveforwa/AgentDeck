// 网页窗口的 webview 模式（IS-44）：google、github 这类外部网站拒绝被嵌进 iframe（X-Frame-Options），
// 第三方登录还要 SameSite cookie 和弹窗，所以用 <webview>：它是真正的顶层页面，能登录，也能跟着白板缩放（风险 3 试验）。
//
// 这里是纯逻辑，不 import Electron，方便单测；接 Electron 的部分在 index.ts。
// - 白板页面只能挂 WEB_PARTITION 分区、http(s) 地址的 webview；preload、node 集成一律去掉。
// - 这个分区和白板页面的 session 分开：登录态只在这里，响应头不改写。
// - UA 去掉 Electron 和应用名：Google 登录见到 Electron 会拒绝（“This browser or app may not be secure”）。
// - 页面里的 ⌘[ ⌘] ⌘R 在主进程里直接让 webview 后退、前进、刷新（按键到不了白板页面，没有 iframe 那样的小桥）。

/** 网页窗口 webview 用的分区。persist: 让登录态在重启后还在。 */
export const WEB_PARTITION = 'persist:agentdeck-web';

/** will-attach-webview 时要改的 webPreferences 字段。 */
export interface GuestPreferences {
  preload?: string;
  nodeIntegration?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  contextIsolation?: boolean;
  sandbox?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
}

/**
 * 白板页面要挂 webview 时调用：改写 webPreferences（去掉 preload 等），返回是否允许。
 * 只允许 WEB_PARTITION 分区、http(s) 地址。
 */
export function lockDownWebview(prefs: GuestPreferences, params: { src?: string; partition?: string }): boolean {
  delete prefs.preload;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.contextIsolation = true;
  prefs.sandbox = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
  return params.partition === WEB_PARTITION && /^https?:\/\//i.test(params.src ?? '');
}

/** 去掉 UA 里的 Electron/x 和应用名/x，其余（Chrome/x 等）不动。 */
export function browserUserAgent(ua: string, appName: string): string {
  const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return ua
    .replace(/\sElectron\/\S+/g, '')
    .replace(new RegExp(`\\s${escaped}\\/\\S+`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export type GuestKey = 'back' | 'forward' | 'reload';

/** webview 里按的键是不是网页窗口的快捷键（Mac 用 ⌘，其他平台用 Ctrl）。 */
export function guestShortcut(
  input: { type: string; key: string; meta: boolean; control: boolean; alt: boolean; shift: boolean },
  isMac: boolean,
): GuestKey | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  if (isMac ? !input.meta || input.control : !input.control || input.meta) return null;
  const key = input.key.toLowerCase();
  if (key === '[' && !input.shift) return 'back';
  if (key === ']' && !input.shift) return 'forward';
  if (key === 'r') return 'reload';
  return null;
}

/** 网页里 window.open 打开的地址：http(s) 开成弹窗（第三方登录要靠它），其他协议拒绝。 */
export function popupAllowed(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** 这个分区里允许网页申请的权限。其余（摄像头、麦克风、定位、通知……）一律拒绝。 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen']);
