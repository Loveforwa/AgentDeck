// 违规：假实现依赖了真实服务
import { openDb } from '../../../packages/store/src/index.ts';
export const fakeDb = openDb;
