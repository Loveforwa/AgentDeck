#!/usr/bin/env node
// pnpm --filter @agentdeck/agent-adapters conformance [--agent <id>]... [--only K16]... [--records]
//   --only：只跑这几项，其余保留原来的记录（给要账号的 agent 补跑一项时省额度）。
//   不带 --records：跑 L2（真程序，tmux -L agentdeck-conformance），要 AGENTDECK_REAL_AGENTS=1；跑完写 compat/<agent>.json 和 src/compat/records.ts。
//   --records：只从 compat/*.json 重新生成 src/compat/records.ts（手改了记录之后）。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeRecords } from './records.mjs';

const pkg = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes('--records')) {
  console.log(`wrote ${writeRecords(pkg)}`);
  process.exit(0);
}
const agents = [];
const only = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--agent' && argv[i + 1]) agents.push(argv[++i]);
  else if (argv[i] === '--only' && argv[i + 1]) only.push(argv[++i]);
}
if (process.env.AGENTDECK_REAL_AGENTS !== '1') {
  console.error('L2 runs real agents in tmux. Set AGENTDECK_REAL_AGENTS=1 to run it (pnpm check only runs L1).');
  process.exit(2);
}
const r = spawnSync('pnpm', ['exec', 'vitest', 'run', 'test/conformance/l2.test.ts'], {
  cwd: pkg,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(agents.length ? { AGENTDECK_CONFORMANCE_AGENTS: agents.join(',') } : {}),
    ...(only.length ? { AGENTDECK_CONFORMANCE_ONLY: only.join(',') } : {}),
  },
});
process.exit(r.status ?? 1);
