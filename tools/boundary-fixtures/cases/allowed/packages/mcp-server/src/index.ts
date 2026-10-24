// 允许：mcp-server 只认 contracts 的类型，服务由 apps/desktop 注入
import type { Id } from '../../contracts/src/index.ts';
export const tools = (id: Id) => id;
