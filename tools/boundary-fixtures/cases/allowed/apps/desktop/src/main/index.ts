// 允许：apps/desktop 把服务接到 IPC 上
import { workspaces } from '../../../../packages/workspace-service/src/index.ts';
import { openDb } from '../../../../packages/store/src/index.ts';
export const main = [workspaces, openDb];
