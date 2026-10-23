import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { BoardController } from '../controller.ts';
import type { WindowDefinition } from '../registry.ts';
import type { BoardStoreState } from '../store.ts';

const ControllerContext = createContext<BoardController | null>(null);

export function BoardProvider({ controller, children }: { controller: BoardController; children: ReactNode }) {
  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>;
}

export function useController(): BoardController {
  const c = useContext(ControllerContext);
  if (!c) throw new Error('useController must be used inside <BoardProvider>');
  return c;
}

/** 订阅白板状态的一部分。selector 返回新对象时会每次都重画，取标量或 store 里已有的引用。 */
export function useBoardState<T>(selector: (s: BoardStoreState) => T): T {
  return useStore(useController().store, selector);
}

/** 按类型查注册表，widget 晚注册时也会更新。 */
export function useWindowType(type: string): WindowDefinition | undefined {
  const { registry } = useController();
  useSyncExternalStore(registry.subscribe, registry.version, registry.version);
  return registry.get(type);
}

export function useWindowTypes(): WindowDefinition[] {
  const { registry } = useController();
  useSyncExternalStore(registry.subscribe, registry.version, registry.version);
  return registry.list();
}
