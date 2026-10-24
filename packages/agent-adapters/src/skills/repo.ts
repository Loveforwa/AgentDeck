// 仓库里已经有的 skill（N9）：agent 自己会从仓库里读的目录（.claude/skills 等，见 support.ts），从 cwd 往上找到仓库根。
// 只列出来给人看（source: repo，跟着仓库），AgentDeck 不开关、不改它们。

import { stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { AbsPath, SkillItem } from '@agentdeck/contracts';
import { listSkillFolders } from './library.ts';

/** 从 dir 往上找有 .git（目录或文件，worktree 里是文件）的那一层。找不到返回 null。 */
export async function findRepoRoot(dir: AbsPath): Promise<AbsPath | null> {
  let cur = dir;
  for (;;) {
    try {
      await stat(join(cur, '.git'));
      return cur;
    } catch {
      // 往上一层
    }
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/**
 * cwd 到仓库根（含）每一层的 <层>/<repoDir>/<name>/SKILL.md。id 是 'skill:repo:<相对仓库根的文件夹>'，
 * 同名的只留离 cwd 最近的（agent 也是近的优先）。不在仓库里时只看 cwd 这一层。
 */
export async function scanRepoSkills(cwd: AbsPath, repoDirs: readonly string[]): Promise<SkillItem[]> {
  if (repoDirs.length === 0) return [];
  const root = (await findRepoRoot(cwd)) ?? cwd;
  const levels: AbsPath[] = [];
  for (let cur = cwd; ; cur = dirname(cur)) {
    levels.push(cur);
    if (cur === root || dirname(cur) === cur || !isInside(cur, root)) break;
  }
  const seen = new Set<string>();
  const out: SkillItem[] = [];
  for (const level of levels) {
    for (const rd of repoDirs) {
      const dir = join(level, rd);
      const rel = relative(root, dir).split(sep).join('/');
      for (const item of await listSkillFolders(dir, 'repo', rel)) {
        if (seen.has(item.name)) continue;
        seen.add(item.name);
        out.push(item);
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function isInside(p: string, root: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}
