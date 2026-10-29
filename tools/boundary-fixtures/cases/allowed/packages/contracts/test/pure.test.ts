// 允许：contracts 的单元测试（test/ 下）用 vitest，测自己的纯函数
import { expect, it } from 'vitest';
import type { Id } from '../src/common.ts';
it('works', () => expect('a' satisfies Id).toBe('a'));
