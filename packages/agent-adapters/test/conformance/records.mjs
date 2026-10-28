// compat/*.json → src/compat/records.ts。运行时读 records.ts（打包后不用找 JSON 文件）。
// L2 跑完自动调用；手改了 compat/*.json 之后跑 `pnpm --filter @agentdeck/agent-adapters conformance --records`。
// L1 有一条测试核对两边一致。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function compatDir(pkgDir) {
  return join(pkgDir, 'compat');
}

/** compat/ 下所有记录，按 agent 名排序。 */
export function readCompatFiles(pkgDir) {
  const dir = compatDir(pkgDir);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

export function recordsSource(records) {
  const body = records.map((r) => `  ${JSON.stringify(r.agent)}: ${JSON.stringify(r, null, 2).replace(/\n/g, '\n  ')},`).join('\n');
  return [
    '// 由 test/conformance/records.mjs 从 compat/*.json 生成，不要手改。',
    '// 改了 compat/*.json 之后：pnpm --filter @agentdeck/agent-adapters conformance --records',
    '',
    "import type { CompatRecord } from './types.ts';",
    '',
    'export const COMPAT_RECORDS: Readonly<Record<string, CompatRecord>> = {',
    body,
    '};',
    '',
  ].join('\n');
}

export function writeRecords(pkgDir) {
  const file = join(pkgDir, 'src/compat/records.ts');
  writeFileSync(file, recordsSource(readCompatFiles(pkgDir)));
  return file;
}
