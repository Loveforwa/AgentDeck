# @agentdeck/ui-kit

所有界面共用的基础零件：Button、Menu、Dialog（含 RadioGroup、DialogText）、Toast、Popover。外观对照设计画布“需求 · 界面零件”页（project/spec/Menu.dc.html、Dialog.dc.html、Note.dc.html）。

只依赖 `@agentdeck/design-tokens` 和 React 18（peer）。不依赖其他 ui 包，也不依赖服务。

## 用法

```tsx
import '@agentdeck/ui-kit/base.css'; // 应用入口引一次：tokens + 页面基础样式
import '@agentdeck/design-tokens/fonts.css'; // 可选：打包的 Inter / JetBrains Mono
import { Button, Menu, Popover, Dialog, RadioGroup, ToastProvider, useToast } from '@agentdeck/ui-kit';
```

| 零件 | 要点 |
| --- | --- |
| `Button` | `variant`: `default`（白底细边）/ `primary`（墨色底，一组里最多一个）/ `ghost`（无边框，工具栏、标题栏）；`size`: `md` 26px / `sm` 22px；原生 `disabled` |
| `Menu` | 数据驱动：`items` 里放 `{ id, label, shortcut?, checked?, disabled?, items?, onSelect? }` 或 `{ type: 'separator' }`。`checked` 设了就是勾选项；有 `items` 就是子菜单（右边 ▸）。键盘：↑↓ Home End 移动并跳过禁用项和分隔线、Enter/Space 选中、→ 打开子菜单、← 和 Esc 关子菜单、根菜单 Esc 调 `onClose`、Tab 关闭、首字母跳转。键盘打开时传 `defaultActive="first"`。Menu 本身不定位，放进 `Popover chrome={false}` |
| `Popover` | `anchor` 可以是元素、ref 或 `{ x, y }`（右键菜单）。`placement` 默认 `bottom-start`，放不下翻到对面并夹在视口里。Esc、点外面调 `onClose`；关闭后焦点回到打开前的元素 |
| `Dialog` | 模态。`title`、正文 children、`actions` 按钮行（次要在前，主要在最右）。Esc 调 `onClose`；打开时聚焦 `initialFocus` → `[data-autofocus]` → 正文第一个可聚焦元素 → 第一个按钮；Tab 不出对话框；关闭后焦点还原。默认点遮罩不关闭 |
| `RadioGroup` | 原生 radio，方向键切换。用在对话框正文里 |
| `DialogText` | 正文段落，`tone`: `default` / `muted` / `attention`（只用于会丢东西的风险） |
| `Toast` | `ToastProvider` 包住应用，`useToast().show({ message, action?, duration? })`。一句话、可选一个动作（如 Undo）；默认 4 秒、有动作 6 秒后消失，悬停或聚焦时暂停；最多同时 3 条 |
| `DialogPanel` `PopoverPanel` `Toast` | 只有外观、不带行为的版本，演示页和需要自己摆位置的地方用 |
| `PortalProvider` | 浮层默认渲染到 `document.body`。页面里有不同 `data-theme` 区域时，在区域里放一个容器传进来 |

## 规矩

- 组件和 CSS 里不写颜色值，只用 tokens 变量（`pnpm --filter @agentdeck/design-tokens lint:colors` 会查 `packages/ui/**`）。
- 类名前缀 `ad-`，每个零件一份 CSS，在组件文件里 import。
- 界面文字英文，注释中文。不用渐变、发光、毛玻璃、emoji，不做弹跳和缩放进场。

## 演示页

`pnpm --filter @agentdeck/ui-kit demo` → http://localhost:5310 。左右两栏分别是亮色和暗色，列出每个零件的状态；底部 “Try it” 可以真的打开菜单（含右键）、对话框、提示、弹出框试键盘操作。`demo:build` 打包到 `dist-demo/`（不提交）。

## 测试

`pnpm --filter @agentdeck/ui-kit test`（Vitest + jsdom + Testing Library）：
- `test/menu.test.tsx`：键盘移动、跳过禁用和分隔线、循环、Home/End、Enter/Space、子菜单开关和焦点、Esc 分层、首字母跳转、悬停开子菜单。
- `test/dialog.test.tsx`：Esc 关闭、初始焦点的几种情况、Tab 陷阱两个方向、关闭后焦点还原、单选方向键、遮罩点击。
- `test/toast-popover.test.tsx`：Toast 自动消失、动作、悬停暂停；Popover Esc 和点外面关闭、焦点进出；定位计算的翻转和夹取。

注意 jsdom 不管 `visibility`，真实浏览器里隐藏元素拿不到焦点。改浮层显示逻辑后在演示页里实际按一遍键盘。

`pnpm --filter @agentdeck/ui-kit typecheck`。

## 不许碰

只改本目录。需要新颜色或尺寸去 `packages/design-tokens` 加 token。不要在这里放业务组件（终端窗口、工作区框、面板），它们在各自的 ui 包里。
