// 适配器的能力声明（AH0 的 AgentAdapter.declareCapabilities，AH2 的合格测试按它逐项跑）。
// 每项 yes / partial / no、靠什么做（via）、不是 yes 的原因（英文，界面原样用，见设计画布 A0 第 2 节的表）。
// verifiedUpTo 在这里一律是 null：核对到哪个版本由合格测试的记录（compat/<agent>.json）给，AgentService 算报告时叠上（AH3）。
//
// 这里只声明“适配器做了什么、靠什么做”，不猜：没核对过的写 partial 并说明，没做的写 no 并说明。
// image-input、video-input、invoke-skill、clear-context 留给 RS14、LR2、LR7 实测后填（没有这一项按 no 处理）。

import type { CapabilityEntry, CapabilityKey, CapabilityVia } from '@agentdeck/contracts';

export function yes(key: CapabilityKey, via: CapabilityVia | null): CapabilityEntry {
  return { key, level: 'yes', via, verifiedUpTo: null, reason: null };
}

export function partial(key: CapabilityKey, via: CapabilityVia | null, reason: string): CapabilityEntry {
  return { key, level: 'partial', via, verifiedUpTo: null, reason };
}

export function no(key: CapabilityKey, reason: string, extra: { notNeeded?: boolean } = {}): CapabilityEntry {
  return { key, level: 'no', via: null, verifiedUpTo: null, reason, ...(extra.notNeeded ? { notNeeded: true } : {}) };
}

/** 声明里的一项（测试和报告用）。 */
export function declared(entries: readonly CapabilityEntry[], key: CapabilityKey): CapabilityEntry | null {
  return entries.find((e) => e.key === key) ?? null;
}

/** 状态退回按输出活动判断时 status 一项怎么写（没有钩子、钩子太老、扩展没装）。 */
export function statusFromActivity(reason: string): CapabilityEntry {
  return partial('status', 'output', reason);
}
