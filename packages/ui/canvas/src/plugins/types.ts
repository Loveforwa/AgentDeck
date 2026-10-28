// 插件（PL0，规则见 docs/plugins.md）：贴在白板某个东西上的小功能，开着时旁边有一个看得见的标记。
// 入口统一在右键菜单的 PLUGINS 一组里：打钩表示开着，再点一次关掉；用不了的灰掉并写原因。
// 加一个插件 = 写一个 PluginDefinition，放进 plugins/index.ts 的 PLUGINS。

import type { ComponentType } from 'react';
import type { AgentKind, WindowId, WindowNode, WorkspaceId } from '@agentdeck/contracts';
import type { MenuEntry } from '@agentdeck/ui-kit';
import type { BoardController } from '../controller.ts';
import { BROWSER_TYPE, agentOf, isAgentTerminal, isTerminal } from '../model/windows.ts';

/** 白板上插件能贴的几种东西（docs/plugins.md「第一件事」）。 */
export type PluginThing = 'terminal' | 'browser' | 'frame' | 'board';

/** 底边标记（书签、小提示）的高度，和 design-tokens 的 --plugin-mark-height 一致。框要给它留地方。 */
export const PLUGIN_MARK_HEIGHT = 16;

/** 右键的是什么。board 以后再加（整块白板的插件，例如整台电脑的用量）。 */
export type PluginTarget = { kind: 'window'; windowId: WindowId } | { kind: 'frame'; workspaceId: WorkspaceId };

export type PluginAvailability = { ok: true } | { ok: false; reason: string };

export interface PluginDefinition {
  id: string;
  /** 菜单里的名字，例如 “Auto-approve”。 */
  label: string;
  /** 能贴在哪几种东西上。 */
  attachesTo: readonly PluginThing[];
  /** 贴在终端上时支持哪些 agent；'all' 不限。不在里面的菜单项灰掉，写 “Not supported for kimi”。 */
  agents: readonly AgentKind[] | 'all';
  /**
   * 只给 agent 终端：shell、自定义命令的终端菜单里根本不列这一项（不是灰掉），也不该有标记（IS-68）。
   * 不在 agents 里的 agent（例如 kimi）照常灰掉写原因。
   */
  agentsOnly?: boolean;
  /** 能不能开；不能时的原因写在菜单项后面（例如服务报的 “Not supported for kimi yet”）。不给就是能开。 */
  availability?(c: BoardController, target: PluginTarget): PluginAvailability;
  /** 在这个东西上开着没有（菜单项打钩）。 */
  isOn(c: BoardController, target: PluginTarget): boolean;
  /** 菜单项被点：开着就关，关着就开。 */
  toggle(c: BoardController, target: PluginTarget): void;
  /** 紧跟在开关后面的额外菜单项，例如框上的 “Approval history…”。 */
  menuExtras?(c: BoardController, target: PluginTarget): MenuEntry[];
  /** 开着时画在窗口旁边的标记（自己决定位置，相对窗口节点绝对定位；不能盖住窗口内容）。 */
  WindowMark?: ComponentType<{ windowId: WindowId }>;
  /** 开着时画在框标题里的标记。 */
  FrameMark?: ComponentType<{ workspaceId: WorkspaceId }>;
  /**
   * 白板起来时调一次（Workbench 挂上时），返回停下的函数。给要在后台一直跑的插件用（例如 PL3 Prompt queue 到点发提示词）。
   */
  start?(c: BoardController): () => void;
}

/** 右键的东西是哪一种。 */
export function thingOf(node: WindowNode | undefined, target: PluginTarget): PluginThing | null {
  if (target.kind === 'frame') return 'frame';
  if (!node) return null;
  if (isTerminal(node)) return 'terminal';
  if (node.type === BROWSER_TYPE) return 'browser';
  return null;
}

/** 能贴在这个东西上的插件。 */
export function pluginsFor(plugins: readonly PluginDefinition[], thing: PluginThing | null): PluginDefinition[] {
  return thing ? plugins.filter((p) => p.attachesTo.includes(thing)) : [];
}

/** 右键菜单里的 PLUGINS 一组（小标题 + 每个插件一项 + 它的额外项）。没有能贴的插件时为空。 */
export function pluginMenuSection(c: BoardController, target: PluginTarget, plugins: readonly PluginDefinition[]): MenuEntry[] {
  const node = target.kind === 'window' ? c.windowById(target.windowId) : undefined;
  const thing = thingOf(node, target);
  const list = pluginsFor(plugins, thing);
  const entries: MenuEntry[] = [{ type: 'heading', id: 'plugins-heading', label: 'PLUGINS' }];
  for (const p of list) {
    if (p.agentsOnly && thing === 'terminal' && node && !isAgentTerminal(node)) continue;
    let avail: PluginAvailability = p.availability?.(c, target) ?? { ok: true };
    const agent = node ? agentOf(node) : null;
    if (avail.ok && thing === 'terminal' && p.agents !== 'all' && agent && !p.agents.includes(agent)) {
      avail = { ok: false, reason: `Not supported for ${agent}` };
    }
    const on = avail.ok && p.isOn(c, target);
    entries.push({
      id: `plugin-${p.id}`,
      label: p.label,
      checked: on,
      disabled: !avail.ok,
      ...(avail.ok ? {} : { hint: avail.reason }),
      onSelect: () => p.toggle(c, target),
    });
    entries.push(...(p.menuExtras?.(c, target) ?? []));
  }
  return entries.length > 1 ? entries : [];
}
