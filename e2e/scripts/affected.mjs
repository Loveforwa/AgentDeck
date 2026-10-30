// 只跑受这次改动影响的 e2e（规则在 ../affected.mjs）。
//   node scripts/affected.mjs              和 main 的分叉点比，加上还没提交的改动；打印选中的 spec 和原因，然后构建并跑它们
//   node scripts/affected.mjs --base <ref> 和别的分支 / 提交比
//   node scripts/affected.mjs --list       只打印，不跑
//   node scripts/affected.mjs --check      只查规则：每个 spec 都挂上了、规则里写的 spec 都存在
// 其余参数原样交给 playwright（例如 --retries=0、--repeat-each=3）。
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRules, selectSpecs } from '../affected.mjs';

const E2E = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: E2E, encoding: 'utf8' }).trim();
/** @type {(...args: string[]) => string} */
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const specs = readdirSync(join(E2E, 'tests')).filter((f) => f.endsWith('.e2e.ts'));

const args = process.argv.slice(2);
/** @type {(flag: string) => string | null} */
const take = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const [, v] = args.splice(i, 2);
  return v ?? null;
};
/** @type {(name: string) => boolean} */
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

const problems = checkRules(specs);
if (flag('--check')) {
  for (const p of problems) console.error(`[e2e:affected] ${p}`);
  console.log(problems.length ? `${problems.length} problem(s)` : `rules cover all ${specs.length} spec files`);
  process.exit(problems.length ? 1 : 0);
}
if (problems.length) {
  for (const p of problems) console.error(`[e2e:affected] ${p}`);
  console.error('[e2e:affected] fix e2e/affected.mjs first (see the comment at its top)');
  process.exit(1);
}

const base = take('--base') ?? 'main';
const listOnly = flag('--list');
const mergeBase = git('merge-base', base, 'HEAD');
const files = [
  ...new Set(
    [
      git('diff', '--name-only', mergeBase, 'HEAD'),
      git('diff', '--name-only', 'HEAD'),
      git('ls-files', '--others', '--exclude-standard'),
    ]
      .join('\n')
      .split('\n')
      .filter(Boolean),
  ),
];

// 只改了注释（和空行）的源码文件不影响行为，不算
const COMMENT = /^\s*(\/\/|\/\*|\*|\*\/|<!--)|^\s*$/;
/** @type {(file: string) => boolean} */
const commentOnly = (file) => {
  if (!/\.(ts|tsx|mjs|js|cjs|css)$/.test(file)) return false;
  let diff;
  try {
    diff = git('diff', mergeBase, '--unified=0', '--', file);
  } catch {
    return false;
  }
  const lines = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  return lines.length > 0 && lines.every((l) => COMMENT.test(l.slice(1)));
};
// package.json 只改了 scripts（比如加了个命令）也不影响应用
/** @type {(file: string) => boolean} */
const scriptsOnly = (file) => {
  if (!file.endsWith('package.json')) return false;
  try {
    const before = JSON.parse(git('show', `${mergeBase}:${file}`));
    const after = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
    delete before.scripts;
    delete after.scripts;
    return JSON.stringify(before) === JSON.stringify(after);
  } catch {
    return false;
  }
};
const skipped = files.filter((f) => commentOnly(f) || scriptsOnly(f));
const { all, specs: picked, reasons, unmatched } = selectSpecs(files.filter((f) => !skipped.includes(f)), specs);
console.log(`[e2e:affected] ${files.length} changed file(s) since ${base} (${mergeBase.slice(0, 7)}) plus uncommitted`);
for (const f of skipped) console.log(`[e2e:affected] only comments or scripts changed in ${f}: not counted`);
for (const f of unmatched) console.log(`[e2e:affected] no rule for ${f}: running everything (add a rule in e2e/affected.mjs)`);
if (all) {
  console.log(`[e2e:affected] everything (${specs.length} spec files), because of: ${(reasons.get('*') ?? unmatched).slice(0, 8).join(', ')}`);
} else if (picked.length === 0) {
  console.log('[e2e:affected] nothing to run: no app code changed');
  process.exit(0);
} else {
  console.log(`[e2e:affected] ${picked.length} of ${specs.length} spec files:`);
  for (const s of picked) console.log(`  ${s}  ← ${[...new Set(reasons.get(s) ?? [])].slice(0, 3).join(', ')}`);
}
if (listOnly) process.exit(0);

/** @type {(cmd: string, cmdArgs: string[]) => void} */
const run = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: E2E, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('node', ['scripts/build-app.mjs']);
run('pnpm', ['exec', 'playwright', 'test', ...(all ? [] : picked.map((s) => `tests/${s}`)), ...args]);

