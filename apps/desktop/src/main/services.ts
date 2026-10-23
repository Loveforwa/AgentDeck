// 应用唯一的服务注册表和事件出口。服务实现（以及组装代码）从这里 import。

import { webContents } from 'electron';
import { createEmitter } from './events.ts';
import { createServiceRegistry } from './registry.ts';

export const registry = createServiceRegistry();
/** 注册一个服务：registerService('git', gitService)。 */
export const registerService = registry.register;
/** 推事件给所有窗口：emit({ type: 'git.changed', ... })。 */
export const emit = createEmitter(() => webContents.getAllWebContents());
