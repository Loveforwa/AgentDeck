// 允许：唯一的服务间依赖 workspace-service → git-service
import { git } from '../../git-service/src/index.ts';
export const workspaces = git;
