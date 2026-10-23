// 允许：假实现用 contracts、node 内置模块
import { tmpdir } from 'node:os';
import type { Id } from '../../../packages/contracts/src/index.ts';
export const fakeTerminalHost = (id: Id) => id;
export const makeTempRepo = () => tmpdir();
