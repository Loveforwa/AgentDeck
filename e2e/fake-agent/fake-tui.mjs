#!/usr/bin/env node
// 端到端测试用的假数据库 TUI（g3：TC-109 的 harlequin、TC-110 的 harlequin / lazysql / pgcli）。包装脚本：node fake-tui.mjs <名字> [参数…]。
// 像 harlequin 那样开着 bracketed paste（ESC[?2004h）：粘贴进来的一整段原样放进“查询编辑器”画出来（换行、-- 注释都在），不执行；
// 在编辑器里回车只是换行（harlequin 要 ⌃↩ 才跑查询）。收到的东西都记日志：kind: paste（text 原文）、key（单个按键）、line（回车提交的一行）。
// 日志：$AGENTDECK_E2E_LOG_DIR/tui-<名字>-<pid>.jsonl。

import { logger, write } from './fake-common.mjs';

const [name = 'tui', ...rest] = process.argv.slice(2);
const log = logger(`tui-${name}-${process.pid}`);
log({ kind: 'start', name, argv: rest });

/** 编辑器里的字（粘贴和打字都进这里）。 */
let editor = '';
function draw() {
  write('\x1b[2J\x1b[H');
  write(`\x1b[1m${name}\x1b[0m (AgentDeck e2e fake) ${rest.join(' ')}\n`);
  write('── Query editor ──────────────────────────\n');
  write(editor.length > 0 ? `${editor}\n` : '\n');
  write('──────────────────────────────────────────\n');
  write('ctrl+enter run · ctrl+q quit\n');
}

process.stdout.write('\x1b[?2004h');
draw();
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let pasting = false;
let pasted = '';
let line = '';
process.stdin.on('data', (c) => {
  for (const part of String(c).split(/(\x1b\[20[01]~)/)) {
    if (part === '\x1b[200~') {
      pasting = true;
      pasted = '';
    } else if (part === '\x1b[201~') {
      pasting = false;
      log({ kind: 'paste', text: pasted });
      editor += pasted.replace(/\r\n?/g, '\n');
      draw();
    } else if (pasting) pasted += part;
    else {
      for (const ch of part) {
        if (ch === '\x11' || ch === '\x03') {
          process.stdout.write('\x1b[?2004l');
          process.exit(0);
        }
        log({ kind: 'key', key: ch });
        if (ch === '\r' || ch === '\n') {
          log({ kind: 'line', text: line });
          line = '';
          editor += '\n';
        } else if (ch >= ' ') {
          line += ch;
          editor += ch;
        }
      }
      draw();
    }
  }
});
process.stdin.on('end', () => process.exit(0));
