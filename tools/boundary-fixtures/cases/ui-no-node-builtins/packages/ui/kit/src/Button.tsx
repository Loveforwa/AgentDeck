// 违规：界面 import node 内置模块
import { readFileSync } from 'node:fs';
import { join } from 'path';
export const read = () => readFileSync(join('a', 'b'));
