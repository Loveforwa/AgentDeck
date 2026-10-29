// 每种 agent 的 Auto-approve 怎么做（PL1 · DR-56）。界面的右键菜单据此灰掉不支持的 agent，ApprovalService 据此选做法。
//
// | agent  | 做法                                                   | 按键        | 核对                                   |
// | ------ | ------------------------------------------------------ | ----------- | -------------------------------------- |
// | claude | PermissionRequest 钩子回 allow；开关前就在等的发按键   | 1           | 钩子实测；按键见 DR-43                 |
// | codex  | 同 claude                                              | y（不发 p/a）| 钩子实测；按键见 DR-43                 |
// | kimi   | 先不支持（2026-10-25 定）。DR-56 的做法是看屏幕发 1，调研记录在 known.ts | — | —                       |
// | omp    | 扩展报 PermissionRequest，屏幕出现 Allow tool: 后发按键 | Up Enter    | 18.0.4 源码 + 2026-10-28 真 TUI（AH2 L2）|
// | pi     | 从来不弹确认框，没事可做                               | —           | 0.83.0                                 |
// | shell / custom | 不支持                                         | —           | —                                      |
//
// 按键本身在各适配器的 approveOnceKeys（claude.ts、codex.ts、known.ts）。

import type { AgentKind, AutoApproveSupport } from '@agentdeck/contracts';
import type { ScreenKind } from './screens.ts';

export interface ApprovalStrategy extends AutoApproveSupport {
  /** 发按键之前要先在屏幕上认出确认框（omp）。 */
  screen: ScreenKind | null;
}

const STRATEGIES: Record<string, Omit<ApprovalStrategy, 'agent'>> = {
  claude: { method: 'hook', verified: true, note: null, screen: null },
  codex: { method: 'hook', verified: true, note: null, screen: null },
  omp: { method: 'keys', verified: true, note: null, screen: 'omp' },
  pi: { method: 'never-asks', verified: true, note: 'pi never asks for approval', screen: null },
  kimi: { method: 'unsupported', verified: false, note: 'Not supported for kimi yet', screen: null },
};

/** 列给界面的 agent（AgentKind 里能开终端的几种）。 */
export const SUPPORT_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'kimi', 'omp', 'pi', 'shell', 'custom'];

export function approvalStrategy(agent: AgentKind): ApprovalStrategy {
  const s = STRATEGIES[agent];
  if (s) return { agent, ...s };
  return { agent, method: 'unsupported', verified: false, note: `Not supported for ${agent}`, screen: null };
}

export function autoApproveSupport(agents: readonly AgentKind[] = SUPPORT_AGENTS): AutoApproveSupport[] {
  return agents.map((a) => {
    const { screen: _screen, ...rest } = approvalStrategy(a);
    return rest;
  });
}
