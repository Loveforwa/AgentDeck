// 构建配置在 node 里跑，可以用 node 内置模块。
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('.', import.meta.url));
