// 窗口注册表：白板上能放哪些窗口（终端、网页……）。加一种窗口 = 一个 widget 包里调一次 registerWindow。
// 这是 canvas 唯一对别的界面包开放的文件（见 .dependency-cruiser.cjs 的 UI_SHARED），只依赖 contracts 和 react 的类型。
// 白板按 WindowNode.type 在这里查定义，把 contracts 的 WindowComponentProps 交给 definition.component。

import type { ComponentType } from 'react';
import type { Unsubscribe, WindowComponentProps, WindowId, WindowTypeDefinition } from '@agentdeck/contracts';

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

// ---- 窗口内容（CO3：Send selection to ▸）----
// 白板的菜单要知道窗口里选中了什么、要往窗口里粘贴；contracts 的 WindowComponentProps 里没有这两样，
// 所以窗口组件挂上时在这里登记一个句柄（只在界面里用，不经过服务）。白板只认这个接口，不按 type 写特例。

/** WindowContentHandle.paste 的结果。不成功时 reason 是给用户看的一句英文（白板用 Toast 显示）。 */
export type PasteResult = { ok: true } | { ok: false; reason: string };

export interface PasteOptions {
  /**
   * 目标程序没开 bracketed paste 时多行文字会被一行行执行：true 时这种情况不贴、返回原因（Send selection to ▸ 用，只粘贴不运行）；
   * false 时照贴（菜单的 Paste，和 ⌘V 一样）。默认 true。
   */
  requireBracketed?: boolean;
  /** 刚开的终端：程序还在启动，多等一会儿（等它开 bracketed paste，或者输出停下来）再贴。 */
  fresh?: boolean;
}

export interface WindowContentHandle {
  /** 现在选中的文字；没有选中为 ''。 */
  selectionText(): string;
  /** 当作一次粘贴放进窗口，不按回车。窗口还没接上显示（刚跳过去、刚开）时等它接上再贴。 */
  paste(text: string, opts?: PasteOptions): Promise<PasteResult>;
}

/**
 * 窗口内容区要白板的右键菜单（Copy · Paste · Send selection to ▸）时，从内容里的元素发这个冒泡事件，
 * detail 是 ContentMenuDetail。白板的窗口节点接住，打开 'window-content' 菜单。
 */
export const CONTENT_MENU_EVENT = 'agentdeck:content-menu';

export interface ContentMenuDetail {
  clientX: number;
  clientY: number;
}

export interface WindowContentRegistry {
  /** 窗口组件挂上时登记，返回撤销函数（卸下时调）。同一个窗口再登记会替换。 */
  register(windowId: WindowId, handle: WindowContentHandle): Unsubscribe;
  get(windowId: WindowId): WindowContentHandle | undefined;
  /** 等这个窗口登记（收起的组成员、刚开的终端要先渲染出来）。超时返回 undefined。 */
  whenRegistered(windowId: WindowId, timeoutMs: number): Promise<WindowContentHandle | undefined>;
}

export function createWindowContentRegistry(): WindowContentRegistry {
  const handles = new Map<WindowId, WindowContentHandle>();
  const waiters = new Map<WindowId, Set<(h: WindowContentHandle) => void>>();
  return {
    register(windowId, handle) {
      handles.set(windowId, handle);
      const ws = waiters.get(windowId);
      if (ws) {
        waiters.delete(windowId);
        for (const w of ws) w(handle);
      }
      return () => {
        if (handles.get(windowId) === handle) handles.delete(windowId);
      };
    },
    get: (windowId) => handles.get(windowId),
    whenRegistered(windowId, timeoutMs) {
      const now = handles.get(windowId);
      if (now) return Promise.resolve(now);
      return new Promise((resolve) => {
        let set = waiters.get(windowId);
        if (!set) waiters.set(windowId, (set = new Set()));
        const done = (h: WindowContentHandle | undefined) => {
          clearTimeout(timer);
          set.delete(done);
          if (set.size === 0 && waiters.get(windowId) === set) waiters.delete(windowId);
          resolve(h);
        };
        const timer = setTimeout(() => done(undefined), timeoutMs);
        set.add(done);
      });
    },
  };
}

/** 全应用共用的窗口内容登记表。窗口组件调 registerWindowContent，白板默认从这里查。 */
export const windowContents: WindowContentRegistry = createWindowContentRegistry();

/** 窗口组件挂上时调：登记选中文字和粘贴的句柄。返回撤销函数。 */
export function registerWindowContent(windowId: WindowId, handle: WindowContentHandle): Unsubscribe {
  return windowContents.register(windowId, handle);
}
