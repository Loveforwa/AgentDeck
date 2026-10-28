// 合格测试的记录（AH2）：compat/<agent>.json，提交进仓库。每次 L2 跑完由 test/conformance/l2.test.ts 写入，
// 再生成 src/compat/records.ts（运行时读它，免得打包后找不到 JSON 文件）。AH3 按它填能力报告的 verifiedUpTo、决定哪些功能关掉。

import type { AgentKind } from '@agentdeck/contracts';
import type { ScenarioId } from './scenarios.ts';

export type CompatResult = 'pass' | 'fail' | 'skip';

export interface CompatItem {
  result: CompatResult;
  /** L2：合格测试的真程序那一级；manual：以前手工在真程序上核对过（AGENTS.md 有记录），L2 还没覆盖；L1：只有离线测试。 */
  suite: 'L2' | 'manual' | 'L1';
  /** skip、fail 的原因（英文）；pass 时可以是一句怎么核对的。 */
  reason?: string;
  /** 这一项在真程序上通过的最高版本。fail 时保留上一次的值（不前进），从没通过过为 null。 */
  verifiedUpTo: string | null;
}

export interface CompatRecord {
  agent: AgentKind;
  /** 最近一次跑的是哪个版本。 */
  version: string | null;
  /** 最近一次跑的日期（YYYY-MM-DD）。 */
  date: string;
  /** 整体核对到的版本：最近一次跑没有 fail 时就是 version，有 fail 时不前进。Settings › Agents 顶上的 “tested up to”。 */
  verifiedUpTo: string | null;
  results: Partial<Record<ScenarioId, CompatItem>>;
  notes?: string[];
}
