// 允许：dev 入口用假实现
import { fakeTerminalHost } from '../../../../tools/fakes/src/index.ts';
export const api = fakeTerminalHost;
