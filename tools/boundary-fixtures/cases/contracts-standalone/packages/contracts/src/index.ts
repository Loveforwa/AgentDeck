// 违规：contracts 依赖第三方包、node 内置模块和其他内部包
// prettier 是根目录装好的包，用它证明「能解析到 node_modules 的第三方包」也会被拦住
import type { Options } from 'prettier';
import { readFileSync } from 'node:fs';
import type { Db } from '../../store/src/index.ts';
export type X = Db | Options | typeof readFileSync;
