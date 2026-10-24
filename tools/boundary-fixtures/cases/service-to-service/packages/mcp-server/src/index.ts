// 违规：mcp-server 直接用 store（服务要从组装层注入）
import { openDb } from '../../../store/src/index.ts';
export const x = openDb;
