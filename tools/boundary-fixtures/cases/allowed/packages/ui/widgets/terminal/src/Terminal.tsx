// 允许：widget 用 contracts、design-tokens、kit、canvas 的注册表、自己的文件
import type { Id } from '../../../../contracts/src/index.ts';
import { tokensCss } from '../../../../design-tokens/src/index.ts';
import { Button } from '../../../kit/src/index.ts';
import { registerWindow } from '../../../canvas/src/registry.ts';
import { theme } from './theme.ts';
export const Terminal = (id: Id) => [id, tokensCss, Button, registerWindow('terminal'), theme];
