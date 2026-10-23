// 允许：测试文件用假实现
import { fakeTerminalHost } from '../../../../../tools/fakes/src/index.ts';
import { Terminal } from './Terminal.tsx';
export const t = [fakeTerminalHost, Terminal];
