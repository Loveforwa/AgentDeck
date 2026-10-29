// 收件箱（Needs you，CR1；按集群分组、Lead 的建议是 CR6、CR19；需求见设计画布“Agent 集群”页 C4、C8）。
// 所有等你的事集中在一处：终端在等批准或回答（集群外的也收）、出错、集群的关卡、Lead 的 ask、Ready to merge、额度上限。
// 这里只定一条的形状（CR0 一起提交）；收件箱的服务（列出、处理、Ask lead）由 CR1 定。

import type { Brand, CrewId, IsoTime, SessionId, TerminalId } from './common.ts';
import type { CrewGateKind } from './crew.ts';
import type { AccountKey } from './limits.ts';
import type { PendingRequest } from './status.ts';

export type InboxItemId = Brand<string, 'InboxItemId'>;

/**
 * 一条从哪来：
 * approval 终端在等批准；question agent 在问你（选择题、要你打字回答、crew ask）；error 终端出错；gate 集群关卡（gateKind 说是哪种）；
 * ready-to-merge 集群做完、等你 Merge into main；lead-ask 自由模式 Lead 跑 crew ask 问你；
 * usage-limit 额度上限要你处理（读不到恢复时间、睡过头、续了又撞，PL4，规格没列，照 PluginResume 第 1 节加）。
 */
export type InboxSource = 'approval' | 'question' | 'error' | 'gate' | 'ready-to-merge' | 'lead-ask' | 'usage-limit';

/** Lead suggests：Lead 读了任务表和 Decisions 后先给的建议。点不点由你。 */
export interface InboxSuggestion {
  by: 'lead';
  /** 建议选哪个（options 里的一项），或一句话。 */
  option: string;
  /** 一句理由，英文原样。 */
  reason: string;
  at: IsoTime;
}

/** 处理过了：谁处理的、答了什么。 */
export interface InboxResolution {
  by: 'user' | 'auto-approve' | 'lead';
  /** 选的项、写的回复、'approved' / 'rejected' 这类。 */
  answer: string;
  at: IsoTime;
}

export interface InboxItem {
  id: InboxItemId;
  source: InboxSource;
  /** 在哪个集群；不在集群里为 null（归在 OTHER TERMINALS）。 */
  crewId: CrewId | null;
  /** source 为 gate 时是哪种关卡（ready-to-merge、lead-ask 有自己的 source）。 */
  gateKind?: CrewGateKind | null;
  /** 关卡的 id（CrewGate.id）。 */
  gateId?: string | null;
  /** 从哪个终端来；集群关卡（Approve plan 这类）为 null。 */
  terminalId: TerminalId | null;
  sessionId?: SessionId | null;
  /** usage-limit 时是哪个账号。 */
  account?: AccountKey | null;
  /** 标题，英文，例如 'Approval'、'Interface change'、'Usage limit · reset time unknown'。 */
  title: string;
  /** 从谁来，例如 'T5 · codex'、'claude · not in a crew'。 */
  from: string;
  /** 一句话：命令、问题原文、关卡说明。 */
  summary: string;
  /** 问题的选项（agent 给的 options）。没有为空数组。 */
  options: string[];
  /** approval、question 时对应的请求。 */
  request?: PendingRequest | null;
  at: IsoTime;
  suggestion: InboxSuggestion | null;
  resolved: InboxResolution | null;
}
