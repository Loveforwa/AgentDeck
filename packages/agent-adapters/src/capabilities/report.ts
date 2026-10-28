// 能力报告（AH0 的 AgentInfo.report、AgentService.check 的返回值）：适配器的声明 + 合格测试记录（compat）+ 运行时降级（AH3，DR-60 P0）。
//
// 规则（画布 A0「4 · 规则」、A1）：
// - verifiedUpTo：这一项对应的 K（src/compat/scenarios.ts）在记录里通过的最低版本（有一项从没通过就是 null）。没有对应 K 的能力为 null。
// - 替你按东西的（approve-keys，以及靠认屏 screen 的）：装的版本比 verifiedUpTo 新、或读不出版本、或从没核对过时降为 no，
//   downgrade 'off'，reason “Untested on <版本>”。钩子、扩展、会话文件、启动参数这些（A、B 档）照常，界面看 report.version 和
//   verifiedUpTo 自己写 “newer than checked”。
// - 上一次启动钩子没来（IS-74）、参数被拒只带会话参数重开（IS-73）：status 写 partial · output，reason 写原因。
// - Check again 发现 --help 里没有要带的参数：对应的几项 no，downgrade 'failed'，reason 写哪个参数。

import type { AgentCapabilityReport, AgentKind, CapabilityEntry, CapabilityKey } from '@agentdeck/contracts';
import { compareVersions } from '../env.ts';
import { scenariosFor } from '../compat/scenarios.ts';
import type { CompatRecord } from '../compat/types.ts';

export interface RuntimeNotes {
  /** 上一次启动的状态退回按输出判断的原因（钩子没来、参数被拒），英文。 */
  status?: string | null;
  /** Check again 失败的项：能力 → 原因（英文，界面写 Failed + 这句）。 */
  failed?: ReadonlyMap<CapabilityKey, string>;
}

export interface BuildReportInput {
  agent: AgentKind;
  label: string;
  version: string | null;
  declared: readonly CapabilityEntry[];
  record: CompatRecord | null;
  checkedAt: string;
  notes?: RuntimeNotes;
}

/** 这一项能力在记录里核对到的版本。 */
export function verifiedUpTo(record: CompatRecord | null, key: CapabilityKey): string | null {
  if (!record) return null;
  const items = scenariosFor(key)
    .map((k) => record.results[k])
    .filter((i): i is NonNullable<typeof i> => !!i && i.result !== 'skip');
  if (items.length === 0) return null;
  let min: string | null = null;
  for (const i of items) {
    if (!i.verifiedUpTo) return null;
    if (min === null || compareVersions(i.verifiedUpTo, min) < 0) min = i.verifiedUpTo;
  }
  return min;
}

/** 装的版本有没有超过核对版本（读不出版本、从没核对过都算超过）。 */
export function newerThanChecked(version: string | null, checked: string | null): boolean {
  return version === null || checked === null || compareVersions(version, checked) > 0;
}

/** 会替你按键的那几项：版本没核对过就关掉。 */
function pressesKeys(e: CapabilityEntry): boolean {
  return e.level !== 'no' && (e.via === 'screen' || (e.key === 'approve-keys' && e.via === 'keys'));
}

export function buildReport(input: BuildReportInput): AgentCapabilityReport {
  const { version, record, notes } = input;
  const entries = input.declared.map((d): CapabilityEntry => {
    const e: CapabilityEntry = { ...d, verifiedUpTo: verifiedUpTo(record, d.key) };
    const failed = notes?.failed?.get(d.key);
    if (failed) return { ...e, level: 'no', via: null, reason: failed, downgrade: 'failed' };
    if (pressesKeys(e) && newerThanChecked(version, e.verifiedUpTo)) {
      const reason = version === null ? `Untested: couldn't read the ${input.label} version` : `Untested on ${version}`;
      return { ...e, level: 'no', reason, downgrade: 'off' };
    }
    if (d.key === 'status' && notes?.status && e.level !== 'no') {
      return { ...e, level: 'partial', via: 'output', reason: notes.status };
    }
    return e;
  });
  return { agent: input.agent, version, checkedAt: input.checkedAt, entries };
}
