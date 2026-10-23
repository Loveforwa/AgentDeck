# @agentdeck/ui-canvas

白板（线 2）。现在只有窗口注册表，白板本身随后补上。

## 窗口注册表（`@agentdeck/ui-canvas/registry`）

widget 包（线 1 终端、线 5 网页）只能 import 这个子路径，canvas 的其他文件不对别的界面包开放。

```ts
import { registerWindow } from '@agentdeck/ui-canvas/registry';

registerWindow<TerminalWindowData>({
  type: 'terminal',
  label: 'Terminal',
  defaultSize: { w: 620, h: 420 },
  minSize: { w: 240, h: 140 },
  summaryBelow: { w: 320, h: 200 }, // 宽或高小于它时 props.summary 为 true
  component: TerminalWindow, // React 组件，props 是 contracts 的 WindowComponentProps<TerminalWindowData>
  create: (init) => ({ ...defaults, ...init }),
});
```

- `registerWindow(def)` 返回撤销函数；同一个 type 再注册会替换（热更新）。
- `getWindowType(type)`、`listWindowTypes()`、`isSummarySize(def, size)`。
- `createWindowRegistry()` 建独立的注册表，测试用；全局的是 `windowRegistry`。

## 测试

`pnpm --filter @agentdeck/ui-canvas test`，`pnpm --filter @agentdeck/ui-canvas typecheck`。
