// SKILLS · MCP 小节（N9）的纯函数：每一行勾没勾、点一下之后的选择、来源的写法、要不要提示重启。
// 选择的规则在 contracts（effectiveSkillSelection、skillsRestartNeeded），这里只是按行套用。

import { effectiveSkillSelection, skillsRestartNeeded } from '@agentdeck/contracts';
import type { SkillItemId, SkillSource, TerminalSkillItem, TerminalSkills } from '@agentdeck/contracts';

export const SOURCE_LABEL: Record<SkillSource, string> = { 'built-in': 'built in', repo: 'repo', library: 'library' };

export interface SkillRow {
  item: TerminalSkillItem;
  checked: boolean;
  disabled: boolean;
  /** 右边那一格：来源，或不支持时的说明。 */
  aside: string;
  /** 悬停说明。 */
  title: string;
}

export function skillRows(items: readonly TerminalSkillItem[], selection: readonly SkillItemId[] | null): SkillRow[] {
  const chosen = new Set(effectiveSkillSelection(items, selection));
  return items.map((item) => {
    const checked = item.source === 'repo' ? true : item.toggleable && chosen.has(item.id);
    const unsupported = !item.toggleable && item.source !== 'repo';
    const lines = [item.description ?? item.detail, item.note, item.path].filter((x): x is string => !!x);
    return {
      item,
      checked,
      disabled: !item.toggleable,
      aside: unsupported && item.note ? item.note : SOURCE_LABEL[item.source],
      title: lines.join('\n'),
    };
  });
}

/** 勾上或取消一项之后要存的选择（只存能开关的，顺序跟着列表）。 */
export function toggleSkill(items: readonly TerminalSkillItem[], selection: readonly SkillItemId[] | null, id: SkillItemId, on: boolean): SkillItemId[] {
  const chosen = new Set(effectiveSkillSelection(items, selection));
  if (on) chosen.add(id);
  else chosen.delete(id);
  return items.filter((i) => i.toggleable && chosen.has(i.id)).map((i) => i.id);
}

/** 新加进库的一项：在当前选择上勾上它（它可能还不在 items 里，所以单独拼在后面）。 */
export function withAdded(items: readonly TerminalSkillItem[], selection: readonly SkillItemId[] | null, id: SkillItemId): SkillItemId[] {
  const now = effectiveSkillSelection(items, selection);
  return now.includes(id) ? now : [...now, id];
}

export function restartNeeded(data: TerminalSkills | null, selection: readonly SkillItemId[] | null): boolean {
  if (!data || data.items.length === 0) return false;
  return skillsRestartNeeded(data.items, selection, data.running);
}

/** Add MCP… 的输入框：http(s):// 开头的是地址，别的当命令。 */
export function mcpTarget(text: string): { command: string } | { url: string } | null {
  const t = text.trim();
  if (t === '') return null;
  return /^https?:\/\//i.test(t) ? { url: t } : { command: t };
}
