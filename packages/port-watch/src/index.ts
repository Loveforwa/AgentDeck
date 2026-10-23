// @agentdeck/port-watch：从终端输出里找 localhost 地址和“文件:行号”（线 1 · T7）。
// 纯函数，不起进程。tmux-host 不能直接 import 它（服务包之间不互相依赖），由组装注入：
//   startTmuxHost({ ..., linkWatcher: () => createLinkWatcher() })

export { createLinkWatcher, type LinkWatcher } from './watcher.ts';
export { findLinkMatches, findLinks, type LinkMatch } from './links.ts';
export { stripAnsi, toVisible, type Visible } from './ansi.ts';
