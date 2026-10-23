// 违规：workspace-service 除了 git-service 还直接用了 tmux-host
import { git } from '../../git-service/src/index.ts';
import { newSession } from '../../tmux-host/src/index.ts';
export const x = [git, newSession];
