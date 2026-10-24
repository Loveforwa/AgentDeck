# @agentdeck/design-tokens

AgentDeck 的样子只在这里定：颜色（亮 / 暗两套）、字体、字号、圆角、阴影、动效、间距、层级。其他包只用这里的 CSS 变量，不写颜色值。

## 方向（别换）

- 暖灰加墨黑。颜色只表达状态（MVP v2 · V2 红绿灯）：`--status-running` 绿（运行中，也是 Running 的文字色）、`--status-waiting` 黄（等你的灯和窗口边框）、`--attention` 黄色系文字（Waiting、需要你处理、会丢东西的风险提示）、`--status-error` 红（出错，也是 Error 的文字色）。状态灯是图形，和底色对比至少 3:1；文字 4.5:1，测试里都有。另外 `--guide` 蓝色只给白板拖动时临时出现的对齐线和间距、尺寸标注（MVP v2 · V3）。其他地方不用彩色。
- 不用渐变、发光、毛玻璃、emoji。用 1px 线分隔；只有浮起来的东西（菜单、弹出框、对话框、提示、拖动中的窗口）有 `--shadow-float`。
- 字号只有 11 / 12 / 13 / 15；圆角控件 6、窗口 8、框和面板 12（`--radius-inset` 4 只给嵌在 6 圆角容器里的高亮）。
- 动效一种：`--motion`（140ms 减速曲线），系统开了减少动效时时长为 0。
- 深色是暖深灰不是纯黑；深色下靠 `--raised` 比 `--surface` 亮一档表现“浮起来”。

## 文件

| 文件 | 内容 |
| --- | --- |
| `src/index.ts` | **唯一的源头**。`light` / `dark` 两套颜色、`font` `text` `radius` `motion` 等常量、`vars`（TS 里引用变量用）、`renderTokensCss()` |
| `tokens.css` | 生成出来的 CSS 变量。**不要手改**，改完 `src/index.ts` 跑 `pnpm --filter @agentdeck/design-tokens gen` |
| `fonts.css` | 打包 Inter 和 JetBrains Mono（@fontsource-variable），应用离线也能用。可选 |
| `lint/raw-colors.mjs` | 禁止界面代码写颜色值的检查：命令行 + ESLint 插件 |

## 对外接口

- CSS：`@import '@agentdeck/design-tokens/tokens.css'`（`@agentdeck/ui-kit/base.css` 已经引了）。
- 主题切换：默认亮色，跟随 `prefers-color-scheme`；任何元素上加 `data-theme="light" | "dark"` 强制它里面的主题。
- 变量名：颜色 `--ground --surface --raised --hover --ink --ink-hover --on-ink --muted --line --line-strong --line-subtle --attention --on-attention --status-running --status-waiting --status-error --guide --focus --scrim --shadow-float`；其他 `--font-ui --font-mono --text-{xs,sm,md,lg} --leading --weight-{regular,medium,strong} --space-{2xs,xs,sm,md,lg,xl,2xl} --control-sm --control-md --row --radius-{inset,control,window,frame} --motion --motion-duration --motion-ease --opacity-disabled --z-{dialog,popover,toast}`。
- TS：`import { themes, vars } from '@agentdeck/design-tokens'`。`themes.dark.ink` 这种实际颜色值只给必须要字面值的地方用（比如 xterm.js 的主题）；inline style 用 `vars.color.ink`（即 `var(--ink)`）。

## 颜色检查

- 命令行：`pnpm --filter @agentdeck/design-tokens lint:colors`，默认扫 `packages/ui/**` 的 `.ts .tsx .css`，发现十六进制颜色或 `rgb() rgba() hsl() hsla() hwb() lab() lch() oklab() oklch()` 就退出码 1。可以传别的目录：`node lint/raw-colors.mjs <路径…>`。
- ESLint：`import agentdeck from '@agentdeck/design-tokens/lint'`，规则 `agentdeck/no-raw-colors`（查字符串、模板字符串、JSX 文本）。F5 目前用根配置里的 `no-restricted-syntax` 实现同样的正则，CSS 靠命令行；合并后根目录 `check` 要加上 `lint:colors`。
- 确实需要字面值的一行，加注释 `raw-color-ok` 并写原因。本包自己不受检查。

## 测试

`pnpm --filter @agentdeck/design-tokens test`：tokens.css 和源头一致、三处主题块齐全、减少动效、两套主题文字对比度都 ≥ 4.5:1、颜色检查的正则和 ESLint 规则。

`pnpm --filter @agentdeck/design-tokens typecheck`。

## 不许碰

只改本目录。加颜色先想清楚是不是已有的 token 能表达；新加的 token 两套主题都要给值，文字类的加进对比度测试。
