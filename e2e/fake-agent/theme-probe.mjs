#!/usr/bin/env node
// 端到端测试用（TC-26）：像 claude 的 auto 主题那样跟着终端换深浅色。node theme-probe.mjs <日志文件>
// - 启动时打开 ?2031（深浅色变化通知），问一次背景色（OSC 11）；
// - 收到 CSI ? 997 ; 1|2 n（1 = 深色，2 = 浅色）就记一行，再问一次背景色；收到 OSC 11 的回答也记一行。
// - 屏幕上画一行 “theme: dark · bg rgb:…”，q 退出（退出前关掉 ?2031）。
// 每行日志是 JSON：{ "kind": "report", "mode": 1 } / { "kind": "bg", "value": "rgb:1616/1616/1515" }。只用 node 内置模块。
import { appendFileSync } from 'node:fs';

const logFile = process.argv[2];
/** @param {Record<string, unknown>} entry */
const log = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
};
/** @type {number | null} */
let mode = null;
/** @type {string | null} */
let bg = null;
const draw = () => process.stdout.write(`\r\x1b[2Ktheme: ${mode === 1 ? 'dark' : mode === 2 ? 'light' : '?'} · bg ${bg ?? '?'}`);

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('latin1');
process.stdout.write('Theme probe (e2e)\r\n');
process.stdout.write('\x1b[?2031h');
process.stdout.write('\x1b]11;?\x07');
draw();

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const report = buf.match(/\x1b\[\?997;([12])n/);
    const osc = buf.match(/\x1b\]11;([^\x07\x1b]*)(\x07|\x1b\\)/);
    const first = [report, osc].flatMap((m) => (m ? [m] : [])).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];
    if (!first) break;
    buf = buf.slice((first.index ?? 0) + first[0].length);
    if (first === report) {
      mode = Number(first[1]);
      log({ kind: 'report', mode });
      process.stdout.write('\x1b]11;?\x07');
    } else {
      bg = first[1] ?? null;
      log({ kind: 'bg', value: bg });
    }
    draw();
  }
  if (buf.includes('q')) {
    process.stdout.write('\x1b[?2031l\r\n');
    process.exit(0);
  }
  // 留着可能没收完的转义序列，别的丢掉
  const esc = buf.lastIndexOf('\x1b');
  buf = esc >= 0 ? buf.slice(esc) : '';
});
