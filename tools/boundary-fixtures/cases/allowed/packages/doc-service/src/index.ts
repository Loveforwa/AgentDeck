// 允许：doc-service 用 contracts（GitService 的接口、parseCodeRefs）和 node 内置模块
import { watch } from 'node:fs';
import type { Id } from '../../contracts/src/index.ts';
export const docs = (id: Id) => [watch, id];
