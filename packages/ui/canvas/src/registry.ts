// 窗口注册表：白板上能放哪些窗口（终端、网页……）。加一种窗口 = 一个 widget 包里调一次 registerWindow。
// 这是 canvas 唯一对别的界面包开放的文件（见 .dependency-cruiser.cjs 的 UI_SHARED），只依赖 contracts 和 react 的类型。
// 白板按 WindowNode.type 在这里查定义，把 contracts 的 WindowComponentProps 交给 definition.component。

import type { ComponentType } from 'react';
import type { Unsubscribe, WindowComponentProps, WindowTypeDefinition } from '@agentdeck/contracts';

/** 窗口组件：拿到的 props 就是 contracts 里的 WindowComponentProps。 */
export type WindowComponent<TData = unknown> = ComponentType<WindowComponentProps<TData>>;

/** ui 层的注册表条目：contracts 的 WindowTypeDefinition，组件类型定为 React 组件。 */
export type WindowDefinition<TData = unknown> = WindowTypeDefinition<TData, WindowComponent<TData>>;

export interface WindowRegistry {
  /**
   * 注册一种窗口。同一个 type 再注册一次会替换旧的（开发时热更新会这样），返回的函数只撤销这一次注册。
   */
  register<TData>(def: WindowDefinition<TData>): Unsubscribe;
  get(type: string): WindowDefinition | undefined;
  /** 按注册顺序。 */
  list(): WindowDefinition[];
  /** 注册表变化时调用（widget 可能比白板晚加载）。React 里用 useSyncExternalStore 订阅。 */
  subscribe(listener: () => void): Unsubscribe;
  /** 每次变化都会换一个新值，给 useSyncExternalStore 当快照用。 */
  version(): number;
}

export function createWindowRegistry(): WindowRegistry {
  // 存进来的组件参数类型各不相同，取出来时统一当 unknown 数据用；白板只把自己保存的 data 原样交回给同一个组件。
  const defs = new Map<string, WindowDefinition>();
  const listeners = new Set<() => void>();
  let ver = 0;
  const changed = () => {
    ver += 1;
    for (const l of [...listeners]) l();
  };

  return {
    register<TData>(def: WindowDefinition<TData>): Unsubscribe {
      validate(def);
      const stored = def as unknown as WindowDefinition;
      defs.set(def.type, stored);
      changed();
      return () => {
        if (defs.get(def.type) !== stored) return;
        defs.delete(def.type);
        changed();
      };
    },
    get: (type) => defs.get(type),
    list: () => [...defs.values()],
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => ver,
  };
}

function validate(def: Pick<WindowDefinition, 'type' | 'defaultSize' | 'minSize' | 'summaryBelow'>): void {
  if (!def.type) throw new Error('registerWindow: type is required');
  const sizes = { defaultSize: def.defaultSize, minSize: def.minSize, summaryBelow: def.summaryBelow };
  for (const [name, size] of Object.entries(sizes)) {
    if (size === undefined) continue;
    if (!(size.w > 0 && size.h > 0)) throw new Error(`registerWindow(${def.type}): ${name} must be positive`);
  }
  if (def.defaultSize.w < def.minSize.w || def.defaultSize.h < def.minSize.h) {
    throw new Error(`registerWindow(${def.type}): defaultSize is smaller than minSize`);
  }
}

/** 全应用共用的注册表。widget 调 registerWindow，白板默认从这里查。 */
export const windowRegistry: WindowRegistry = createWindowRegistry();

/** 往全局注册表里注册一种窗口。返回撤销注册的函数。 */
export function registerWindow<TData>(def: WindowDefinition<TData>): Unsubscribe {
  return windowRegistry.register(def);
}

export function getWindowType(type: string): WindowDefinition | undefined {
  return windowRegistry.get(type);
}

export function listWindowTypes(): WindowDefinition[] {
  return windowRegistry.list();
}

/** 窗口当前尺寸是否该画成摘要卡：宽或高小于 summaryBelow。没有 summaryBelow 的类型永远 false。 */
export function isSummarySize(def: Pick<WindowDefinition, 'summaryBelow'>, size: { w: number; h: number }): boolean {
  const s = def.summaryBelow;
  return !!s && (size.w < s.w || size.h < s.h);
}
