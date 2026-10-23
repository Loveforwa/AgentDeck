// 违规：apps/desktop 以外的地方直接用服务
import { start } from '../../../packages/agent-adapters/src/index.ts';
export const x = start;
