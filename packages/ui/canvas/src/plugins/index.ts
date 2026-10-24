// 插件登记表（PL0）。加插件：写一个 PluginDefinition（见 types.ts），在这里加一行；
// 右键菜单的 PLUGINS 一组、窗口和框上的标记都从这里来。docs/plugins.md 的登记表同步更新。

import { autoApprovePlugin } from './auto-approve.tsx';
import type { PluginDefinition } from './types.ts';

export const PLUGINS: readonly PluginDefinition[] = [
  autoApprovePlugin,
  // PL2 Usage 放在这里
];

export { pluginMenuSection, pluginsFor, thingOf, type PluginDefinition, type PluginTarget, type PluginThing } from './types.ts';
