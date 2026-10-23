// 用 .dependency-cruiser.cjs 检查模块边界。
// 直接调 dependency-cruiser 的 API 而不是 depcruise 命令：命令行版拒绝在奇数版本的 node（比如 25）上跑。
// 用法：node scripts/boundaries.mjs [目录]，目录默认是仓库根目录。有违规时退出码为 1。
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cruise } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = resolve(ROOT, '.dependency-cruiser.cjs');
const SCAN = ['packages', 'apps', 'tools'];

/**
 * 在 baseDir 下按根目录的规则跑一遍，返回违规列表。
 * 规则里的路径相对 baseDir，所以样例目录可以模仿仓库结构（packages/ui/...）。
 * @param {string} baseDir
 * @returns {Promise<Array<{ rule: string, from: string, to: string }>>}
 */
export async function findViolations(baseDir = ROOT) {
  const options = await extractDepcruiseOptions(CONFIG);
  const targets = SCAN.filter((dir) => existsSync(resolve(baseDir, dir)));
  if (targets.length === 0) return [];
  const { output } = await cruise(targets, { ...options, baseDir });
  return output.summary.violations.map((v) => ({ rule: v.rule.name, from: v.from, to: v.to }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseDir = resolve(process.argv[2] ?? ROOT);
  const violations = await findViolations(baseDir);
  for (const v of violations) console.error(`  ${v.rule}: ${v.from} → ${v.to}`);
  if (violations.length > 0) {
    console.error(`\n${violations.length} boundary violation(s). Rules: .dependency-cruiser.cjs`);
    process.exit(1);
  }
  console.log('boundaries: ok');
}
