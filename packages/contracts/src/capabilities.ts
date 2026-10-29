// 统一的 agent 能力报告（M10 · AH0，需求见设计画布“Agent 接入”页 A0、A1，调研 DR-66）。
// 每家 agent 一份：每项能力 yes / partial / no、靠什么做（via）、核对到哪个版本、不是 yes 的原因（英文，界面直接用）。
// Settings › Agents、菜单的灰掉原因、New crew 的下拉、Auto-approve 都读这一份（AgentInfo.report）。
// 由 packages/agent-adapters 从适配器声明和合格测试记录（AH2 的 compat/<agent>.json）算出来。
// 旧的 AgentCapabilities、AutoApproveSupport 保留，由报告推出（capabilitiesFromReport、autoApproveSupportFromReport）。

import type { AgentKind, IsoTime } from './common.ts';
import type { AgentCapabilities } from './agent.ts';
import type { AutoApproveSupport } from './status.ts';

/**
 * 能力的键（界面上的行名在括号里）：
 * first-prompt（First message）、status（Status）、approval-wait（Approval wait）、question（Questions）、
 * session-id（Session id）、resume、fork（Resume · Fork）、history（History）、usage（Usage）、quota（Usage limits）、
 * approve-keys（Approve keys：替你按“允许一次”）、agentdeck-mcp（AgentDeck MCP）、skills（Skills）、subagents（Background agents）；
 * 2026-10-28 第二轮加：image-input、video-input（能不能收图片、视频，RS14 实测后填）、append-instructions（能不能往系统提示里追加，LR0）、
 * invoke-skill（能不能按名字调 skill，LR2）、clear-context（能不能清上下文，LR7）、shell-tool（能跑 shell，能用 agentdeck 命令行进集群）。
 */
export type CapabilityKey =
  | 'first-prompt'
  | 'status'
  | 'approval-wait'
  | 'question'
  | 'session-id'
  | 'resume'
  | 'fork'
  | 'history'
  | 'usage'
  | 'quota'
  | 'approve-keys'
  | 'agentdeck-mcp'
  | 'skills'
  | 'subagents'
  | 'image-input'
  | 'video-input'
  | 'append-instructions'
  | 'invoke-skill'
  | 'clear-context'
  | 'shell-tool';

/** 界面上 Support 一列：Yes / Partial / No。 */
export type CapabilityLevel = 'yes' | 'partial' | 'no';

/**
 * 靠什么做（界面上 How 一列）：flag 启动参数、hook 钩子、extension 扩展或插件、session-file 读 agent 的会话文件、
 * screen 认屏、keys 发按键（kimi 的第一条消息是启动后打进去的）、local-server agent 自己起的本地服务（codex app-server、
 * opencode 自带的服务，AH8；原来叫 app-server）、output 看终端输出活动。
 */
export type CapabilityVia = 'flag' | 'hook' | 'extension' | 'session-file' | 'screen' | 'keys' | 'local-server' | 'output';

export interface CapabilityEntry {
  key: CapabilityKey;
  level: CapabilityLevel;
  /** level 为 no 时通常为 null。 */
  via: CapabilityVia | null;
  /** 合格测试核对到的 agent 版本（compat 记录）；没核对过为 null。 */
  verifiedUpTo: string | null;
  /** 不是 yes 时的原因，英文，菜单 hint 原样用，例如 "Kimi can't fork conversations"、"Untested on 18.12.6"。yes 时为 null。 */
  reason: string | null;
  /**
   * 界面上 Support 写 Off 或 Failed 而不是 No（level 仍是 no）：off 是版本超过核对版本时自动关掉的（AH3），
   * failed 是 Check again 时这一项失败了（reason 写输出的第一行）。不填是照 level 写。规格只有三档，这两种写法放在这个可选字段里。
   */
  downgrade?: 'off' | 'failed' | null;
  /**
   * 这一项对这家用不上（例如 pi 从不请求批准，approval-wait、approve-keys 都是 no，但不是缺陷）。
   * Auto-approve 据此报 never-asks 而不是 unsupported。
   */
  notNeeded?: boolean;
}

export interface AgentCapabilityReport {
  agent: AgentKind;
  /** 装的版本；读不出为 null（按没核对处理）。 */
  version: string | null;
  checkedAt: IsoTime;
  entries: CapabilityEntry[];
}

/** 报告里的一项；没有这一项时按 no 处理，返回 null。 */
export function capabilityEntry(report: AgentCapabilityReport, key: CapabilityKey): CapabilityEntry | null {
  return report.entries.find((e) => e.key === key) ?? null;
}

/** 这一项能用（yes 或 partial）。 */
export function hasCapability(report: AgentCapabilityReport, key: CapabilityKey): boolean {
  const e = capabilityEntry(report, key);
  return e !== null && e.level !== 'no';
}

/** 状态从哪来算“有钩子”：钩子、扩展、agent 自己的本地服务。看屏幕、看输出不算。 */
const HOOK_LIKE: readonly CapabilityVia[] = ['hook', 'extension', 'local-server'];

/**
 * 旧的 AgentCapabilities 由报告推出：
 * hooks = status 为 yes 且靠钩子、扩展或本地服务；resume、fork、askTool（question）= 这一项不是 no。
 */
export function capabilitiesFromReport(report: AgentCapabilityReport): AgentCapabilities {
  const status = capabilityEntry(report, 'status');
  return {
    hooks: status !== null && status.level === 'yes' && status.via !== null && HOOK_LIKE.includes(status.via),
    resume: hasCapability(report, 'resume'),
    fork: hasCapability(report, 'fork'),
    askTool: hasCapability(report, 'question'),
  };
}

/**
 * 旧的 AutoApproveSupport 由报告的 approve-keys 一项推出：
 * 靠钩子 → hook；靠认屏或按键 → keys（只有 yes 算 verified）；no 且 notNeeded → never-asks；其余 → unsupported。
 * note 用 reason（yes 时为 null）。
 */
export function autoApproveSupportFromReport(report: AgentCapabilityReport): AutoApproveSupport {
  const e = capabilityEntry(report, 'approve-keys');
  const base = { agent: report.agent, note: e?.reason ?? null };
  if (e === null) return { ...base, method: 'unsupported', verified: false, note: 'Not supported' };
  if (e.level === 'no') return { ...base, method: e.notNeeded ? 'never-asks' : 'unsupported', verified: e.notNeeded === true };
  if (e.via === 'hook' || e.via === 'local-server' || e.via === 'extension') return { ...base, method: 'hook', verified: e.level === 'yes' };
  return { ...base, method: 'keys', verified: e.level === 'yes' };
}
