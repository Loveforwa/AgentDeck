// 允许：canvas 用自己的文件、kit、第三方包
import { useState } from 'react';
import { Button } from '../../kit/src/index.ts';
import { registerWindow } from './registry.ts';
export const Board = [useState, Button, registerWindow];
