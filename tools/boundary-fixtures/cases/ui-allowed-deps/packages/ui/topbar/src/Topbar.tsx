// 违规：topbar 用了 window-shell，以及 canvas 里注册表以外的文件
import { Frame } from '../../window-shell/src/index.ts';
import { Board } from '../../canvas/src/Board.tsx';
export const Topbar = [Frame, Board];
