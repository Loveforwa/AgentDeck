// 违规：doc-service 直接用 store（核对缓存要由 apps/desktop 注入 store.docAnchors）
import { openDb } from '../../store/src/index.ts';
export const x = openDb;
