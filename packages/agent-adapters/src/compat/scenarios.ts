// 适配器合格测试（AH2，画布 A1 第 2 节）：每家 agent 都跑同一张表 K1–K18。
// capability 是这一项对应的能力（适配器声明 no 的跳过，并检查原因写了）；null 的每家都跑。
// L1（test/conformance/l1.test.ts）离线：fixture、假 PATH、假程序，进 pnpm check。L2（test/conformance/l2.test.ts）真程序在 tmux 里跑，AGENTDECK_REAL_AGENTS=1 才跑。

import type { AgentKind, CapabilityKey } from '@agentdeck/contracts';

export type ScenarioId =
  | 'K1' | 'K2' | 'K3' | 'K4' | 'K5' | 'K6' | 'K7' | 'K8' | 'K9'
  | 'K10' | 'K11' | 'K12' | 'K13' | 'K14' | 'K15' | 'K16' | 'K17' | 'K18';

export interface Scenario {
  id: ScenarioId;
  /** 英文短标题（测试名里用）。 */
  title: string;
  capability: CapabilityKey | null;
}

export const SCENARIOS: readonly Scenario[] = [
  { id: 'K1', title: 'detects the command and its version', capability: null },
  { id: 'K2', title: 'a new conversation gets the first message', capability: 'first-prompt' },
  { id: 'K3', title: 'the session id is known', capability: 'session-id' },
  { id: 'K4', title: 'idle → running → idle with a turn-end', capability: 'status' },
  { id: 'K5', title: 'an approval request turns the light yellow with the command', capability: 'approval-wait' },
  { id: 'K6', title: 'approve once and it carries on', capability: 'approve-keys' },
  { id: 'K7', title: 'deny or Esc goes back to idle', capability: 'status' },
  { id: 'K8', title: 'a question waits for your answer', capability: 'question' },
  { id: 'K9', title: 'resume by id remembers the code word', capability: 'resume' },
  { id: 'K10', title: 'fork into another folder remembers the code word', capability: 'fork' },
  { id: 'K11', title: 'history lists this session', capability: 'history' },
  { id: 'K12', title: 'usage is not empty', capability: 'usage' },
  { id: 'K13', title: 'usage limits have a reset time', capability: 'quota' },
  { id: 'K14', title: 'the AgentDeck MCP is attached', capability: 'agentdeck-mcp' },
  { id: 'K15', title: 'the chosen skills are passed', capability: 'skills' },
  { id: 'K16', title: 'missing hooks fall back to terminal activity and say so', capability: 'status' },
  { id: 'K17', title: 'a rejected launch option restarts with session options only', capability: null },
  { id: 'K18', title: 'the agent works in the frame folder (no worktree of its own)', capability: null },
];

/** 合格测试覆盖的五家（shell、custom 不是 agent）。 */
export const CONFORMANCE_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'pi', 'omp', 'kimi'];

/** 能力 → 覆盖它的 K（报告里 verifiedUpTo 按这些 K 的结果算）。 */
export function scenariosFor(key: CapabilityKey): ScenarioId[] {
  return SCENARIOS.filter((s) => s.capability === key).map((s) => s.id);
}
