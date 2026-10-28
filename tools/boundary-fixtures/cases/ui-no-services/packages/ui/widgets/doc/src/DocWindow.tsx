// 违规：文档窗口直接用 doc-service（要走 window.agentdeck.docs）
import { createDocServices } from '../../../../doc-service/src/index.ts';
export const x = createDocServices;
