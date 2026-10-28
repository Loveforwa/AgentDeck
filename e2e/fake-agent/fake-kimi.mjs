#!/usr/bin/env node
// 端到端测试用的假 kimi（g3：TC-46）。kimi 2.3 的交互模式没有带第一条消息的参数，也没有钩子：
// AgentDeck 等终端第一次安静下来，在输入框里替你打字、停一下再回车（LaunchSpec.sendAfterReady，agent-adapters/src/first-message.ts）。
// 这里画一个输入框，按真键盘一个字一个字收（经 tmux send-keys），回车提交；收到的每一行原文记日志（kind: message）。
// 消息里有 “reply with the word X” 时回答 X。@ 开头的照原文收下（真 kimi 2.3.2 也是）。
//   kimi --version → kimi, version 2.3.3（compat/kimi.json 核对到的版本）
//   -S <id> 接回（不用）
// 日志：$AGENTDECK_E2E_LOG_DIR/kimi-<pid>.jsonl。

import { logger, readLines, write } from './fake-common.mjs';

const VERSION = '2.3.3';
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-V')) {
  process.stdout.write(`kimi, version ${VERSION}\n`);
  process.exit(0);
}
if (argv.includes('--help')) {
  process.stdout.write('Usage: kimi [OPTIONS]\n  -S, --session [id]\n  -V, --version\n  --skills-dir <dir>\n');
  process.exit(0);
}

const log = logger(`kimi-${process.pid}`);
log({ kind: 'start', argv });
let n = 0;

write(`\x1b[1mKimi Code\x1b[0m (AgentDeck e2e fake) v${VERSION}\n  Directory: ${process.cwd()}\n\n`);
const box = () => write('╭──────────────────────────────╮\n│ > ');
box();
readLines({
  onLine: (line) => {
    if (line.trim() === '') return box();
    log({ kind: n++ === 0 ? 'first-message' : 'message', text: line });
    write('╰──────────────────────────────╯\n');
    write(`\n✨ ${line}\n`);
    const word = /reply with the word (\w+)/i.exec(line)?.[1];
    write(`\n  ${word ?? 'OK'}\n\n`);
    box();
  },
});
