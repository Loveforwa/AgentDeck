# @agentdeck/port-watch

从终端输出里找可点的地址（线 1 · T7）：localhost 网址和“文件:行号”。纯函数，不起进程、不碰文件。

## 职责

- tmux-host 把 pipe-pane 抄来的原始输出（含转义序列）一段段喂给 `createLinkWatcher()`，它吐出新出现的链接，tmux-host 据此发 `terminal.link`、维护 `recentLinks`。
- 处理：转义序列在两段之间被切开；一行分几段到达；程序按窗格宽度把长地址折成几行（`setWidth`）；光标定位画屏（codex / ratatui）；OSC 8 超链接；`\r` 覆盖的进度条。

## 对外接口

```ts
import { createLinkWatcher, findLinks, findLinkMatches, stripAnsi } from '@agentdeck/port-watch';

// 组装时注入 tmux-host（服务包之间不能互相 import）
startTmuxHost({ ..., linkWatcher: () => createLinkWatcher() });
```

| 导出 | 说明 |
| --- | --- |
| `createLinkWatcher({ cols? })` | `push(chunk)` 返回这段里新完成的链接；`flush()` 把没换行的最后一段也算上（tmux-host 在 silence 和退出时调）；`setWidth(cols)` |
| `findLinks(line)` | 一行看得见的文字里的链接，按出现顺序 |
| `findLinkMatches(line)` | 同上，带在这一行里的位置（终端窗口画下划线用） |
| `stripAnsi(s)` / `toVisible(s)` | 去掉转义序列；光标定位当换行、光标右移当空格、OSC 8 的地址单独成行 |

识别规则：

- localhost：`http(s)://localhost|127.0.0.1|0.0.0.0|[::1]`，或者不带协议的 `localhost:端口`（“ready on localhost:3000”）。`0.0.0.0` 换成 `localhost`；去掉结尾的标点和多出来的右括号。局域网地址（Vite 的 Network）不算。
- 文件：`path:行(:列)`、`path(行,列)`（tsc）、`File "path", line N`（Python）。文件名要有字母开头的扩展名；`example.com:8080` 这类像域名的不算；网址里的部分不算。

## 和终端窗口的约定

终端窗口（`packages/ui/widgets/terminal/src/links.ts`）有一份同样规则的副本，给 xterm 画下划线用（界面包不能 import 服务包）。两边的例子是同一份 `test/link-cases.json`，终端窗口那边是副本；本包的测试检查两份文件一模一样。**改规则时：改 `src/links.ts` 和 `test/link-cases.json`，再把两个文件复制到终端窗口包**（`src/links.ts` 只换开头的注释）。

## 不许碰

只改 `packages/port-watch/`。不依赖任何内部包（contracts 的类型除外）。

## 怎么跑测试

```bash
pnpm --filter @agentdeck/port-watch test
```
