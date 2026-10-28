#!/usr/bin/env node
// 端到端测试用的最小假 codex（TC-17，fake-codex-mini.mjs；功能全的是 fake-codex.mjs）：只让 AgentDeck 检测到“装了 codex”，被选中时开一个什么也不做的 TUI。
// - `codex --version` 报一个老版本（0.1.0）：AgentDeck 不去问钩子的信任哈希（不起 app-server），启动参数只带 legacy notify。
// - 其他参数：画一行 “Fake Codex”，把收到的每一行回显出来，quit 退出。不联网、不读写 ~/.codex。
// 测试把它以 `codex` 的名字放进沙盒的 fakebin（support/g1.ts 的 installFake）。只用 node 内置模块。

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-V')) {
  process.stdout.write('codex-cli 0.1.0\n');
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('Usage: codex [OPTIONS] [PROMPT]\n');
  process.exit(0);
}

process.stdout.write(`Fake Codex (e2e) · args ${argv.length}\n› `);
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.search(/[\r\n]/)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'quit' || line === 'exit') process.exit(0);
    if (line) process.stdout.write(`\nyou said: ${line}\n› `);
  }
});
process.stdin.on('end', () => process.exit(0));
