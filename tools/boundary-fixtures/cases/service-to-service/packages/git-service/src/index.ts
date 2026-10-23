// 违规：git-service 直接用 store
import { openDb } from '../../store/src/index.ts';
export const x = openDb;
