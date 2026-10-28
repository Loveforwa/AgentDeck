// 插件登记表（PL0）。加插件：写一个 PluginDefinition（见 types.ts），在这里加一行；
// 右键菜单的 PLUGINS 一组、窗口和框上的标记都从这里来。docs/plugins.md 的登记表同步更新。

import { autoApprovePlugin } from './auto-approve.tsx';
import { autoResumePlugin } from './auto-resume.tsx';
import type { PluginDefinition } from './types.ts';
import { usagePlugin } from './usage.tsx';

export const PLUGINS: readonly PluginDefinition[] = [
  autoApprovePlugin,
  usagePlugin,
  // PL6：Auto-resume（2026-10-28 起也收进了 Prompt queue · PL3 剩下的部分，PL3 退役）
  autoResumePlugin,
];

export { pluginMenuSection, pluginsFor, thingOf, type PluginDefinition, type PluginTarget, type PluginThing } from './types.ts';
