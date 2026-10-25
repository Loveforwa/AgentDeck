<div align="center">

<img src="../../apps/desktop/build-resources/icon.png" width="96" height="96" alt="AgentDeck 图标">

# AgentDeck

在一块白板上同时跑多个编程 agent，每个分支一个 git worktree。

<a href="https://github.com/Loveforwa/AgentDeck/releases/latest"><img src="https://img.shields.io/badge/Download_for_macOS-.dmg-1a1a1a?style=for-the-badge&logo=apple&logoColor=white" alt="下载 macOS 版 AgentDeck"></a>

macOS（Apple 芯片或 Intel）· 需要 [tmux](https://github.com/tmux/tmux) 3.5 以上和你要用的 agent · [未签名的应用怎么打开](#安装)

[English](../../README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

<p align="center">
  <img src="../images/demo.gif" width="960" alt="一个 Claude Code 终端通过 AgentDeck 的 MCP 开出三个子 agent 终端；接着按 ⌘J 跳到另一个等批准的 agent，右侧的源代码管理面板跟着聚焦的终端切换">
</p>

AgentDeck 是一个桌面应用，用来同时使用 Claude Code、Codex、Pi、Oh My Pi、Kimi 和普通 shell。每个终端都是真正的 TUI 会话，放在一块可以缩放的白板上。每个分支有一个工作区框，背后是它自己的 git worktree，所以几个 agent 改同一个仓库时不会动到彼此的文件。

AgentDeck 用的是你电脑上已经装好的 agent，不自带，也不改它们的全局配置：钩子和 AgentDeck 的 MCP 服务都通过启动参数传进去。

## 能做什么

### 每个分支一个框

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/overview-dark.webp">
  <img src="../images/overview-light.webp" alt="白板上三个工作区框：一个网店项目的两个 worktree，和另一个仓库的主目录，框里有 agent 终端和 shell" width="960">
</picture>

添加项目、选一个分支，AgentDeck 就建好 worktree，在白板上放一个框。在框里开的终端和网页窗口都从这个目录开始。终端跑在 AgentDeck 自己的 tmux 里，关掉窗口也照常运行；重启电脑后，AgentDeck 会问要不要恢复上次的会话：agent 接着原来的对话，shell 在原目录重新打开。

### 一眼看出哪个 agent 在等你

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/status-dark.webp">
  <img src="../images/status-light.webp" alt="一个 Claude Code 终端在等批准运行 npm test，状态灯是黄色；顶栏显示 4 running、1/1 waiting" width="960">
</picture>

每个终端都有状态灯：运行中是绿色，等你处理是黄色，出错是红色，顶栏上有汇总。按 ⌘J 跳到下一个在等你的终端，⌘⇧J 往回跳。

### 源代码管理就在白板旁边

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/source-control-dark.webp">
  <img src="../images/source-control-light.webp" alt="源代码管理面板：聚焦的终端所在分支的改动文件和提交图" width="960">
</picture>

右侧面板跟着聚焦的终端走：显示它所在 worktree 的改动，可以暂存、提交、切换分支，还有跨分支的提交图。下面的 Skills · MCP 一栏列出这个终端的 agent 启动时带的 skill 和 MCP 服务。

### 本地网页直接在白板上打开

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/web-window-dark.webp">
  <img src="../images/web-window-light.webp" alt="shell 里的 dev server 打印出 http://localhost:3000/，旁边的网页窗口打开了这个页面" width="800">
</picture>

单击终端里的 `localhost` 链接，页面就作为网页窗口开在同一个框里。再点一次同一个链接，会回到那个窗口。

### agent 自己也能开窗口

AgentDeck 在本机跑一个 MCP 服务，启动 Claude Code、Codex 或 Oh My Pi 时自动挂上。agent 可以通过它开终端、开 worktree、开网页窗口，读别的终端的输出，或者一次开一组子 agent。上面的 GIF 用的提示词是 “use the agentdeck open_terminals tool to open 3 claude subagents, one per package”。

### 插件

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/plugins-dark.webp">
  <img src="../images/plugins-light.webp" alt="一个 Claude Code 终端，上方是 Usage 用量条，下方是红色的 Auto-approve 书签" width="480">
</picture>

插件在终端的右键菜单里。Auto-approve 也可以对整个框打开，框里所有 agent 都生效。

- **Auto-approve**：遇到权限请求时替你选“允许一次”。破坏性命令（`rm -rf`、`git push --force` 等）、选择题和需要你打字回答的问题，照样停下来等你。
- **Usage**：显示输入、输出、缓存 token 和上下文用了多少，数据来自 agent 自己的本地会话文件。

## 安装

1. 从 [最新版本](https://github.com/Loveforwa/AgentDeck/releases/latest) 下载对应的 `.dmg`（Apple 芯片选 `arm64`，Intel 选 `x64`），把 AgentDeck 拖进“应用程序”。
2. 安装 tmux 3.5 或更新的版本，以及 git：
   ```sh
   brew install tmux
   xcode-select --install   # 还没有 git 的话
   ```
3. 安装你要用的 agent，并在普通终端里各登录一次（`claude`、`codex`、`pi`、`omp`、`kimi`）。AgentDeck 通过登录 shell 的 `PATH` 找到它们。
4. 打开 AgentDeck。应用没有经过公证，第一次打开会被 macOS 拦下：
   - 在“应用程序”里右键 AgentDeck，选 **打开**，再点一次 **打开**。
   - macOS 15 及以后：先打开一次，然后到 **系统设置 › 隐私与安全性**，点 **仍要打开**。
   - 或者去掉隔离标记：`xattr -dr com.apple.quarantine /Applications/AgentDeck.app`

AgentDeck 的数据（白板、设置、worktree）放在 `~/.agentdeck`。

## 从源码构建

需要 macOS、Node.js 22.12+、pnpm 10、tmux 3.5+ 和 git。

```sh
pnpm install
node apps/desktop/node_modules/electron/install.js   # 只在第一次：下载 Electron

pnpm dev     # 从源码运行（数据在 .agentdeck-dev/，用单独的 tmux）
pnpm check   # 类型检查、lint、颜色和模块边界检查、单元测试
pnpm e2e     # Playwright 端到端测试（会弹出应用窗口）
pnpm dist    # 打包 .dmg，放在 apps/desktop/dist/
```

代码是 pnpm 单仓多包：应用用 Electron 和 React，终端用 xterm.js，白板用 React Flow。每个包都有一份 `AGENTS.md`，说明它负责什么；内部文档大多是中文。

## 许可证

[MIT](../../LICENSE)
