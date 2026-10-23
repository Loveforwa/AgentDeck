// 违规：界面直接用服务包（哪怕只是 import type）
import type { TmuxHost } from '../../../../tmux-host/src/index.ts';
export type Props = { host: TmuxHost };
