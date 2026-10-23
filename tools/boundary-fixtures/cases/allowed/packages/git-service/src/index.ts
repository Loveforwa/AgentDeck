// 允许：服务用 contracts、node 内置模块
import { execFile } from 'node:child_process';
import type { Id } from '../../contracts/src/index.ts';
export const git = (id: Id) => [execFile, id];
