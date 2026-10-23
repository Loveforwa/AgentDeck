// 允许：canvas 用自己的文件、kit、第三方包，以及 window-shell 和 topbar
import { useState } from 'react';
import { Button } from '../../kit/src/index.ts';
import { Topbar } from '../../topbar/src/index.ts';
import { WindowShell } from '../../window-shell/src/index.ts';
import { registerWindow } from './registry.ts';
export const Board = [useState, Button, registerWindow, WindowShell, Topbar];
