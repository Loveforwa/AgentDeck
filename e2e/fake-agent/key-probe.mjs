#!/usr/bin/env node
// 端到端测试用（IS-05 终端手感）：记下程序真正收到的每一段字节，再按命令画颜色、框线，发响铃和 OSC 9。
// node key-probe.mjs [--ext] [--mouse]
// - 启动：开 bracketed paste（ESC[?2004h）；--ext 像 claude、codex 那样申请扩展按键（ESC[>4;2m，tmux 才把 Shift+Enter 发成 CSI 13;2u）；
//   --mouse 像 codex 那样要鼠标（ESC[?1002h ESC[?1006h，拖动交给程序，tmux 不进回滚）。
// - 每次读到的一段都记一行日志 kind: bytes（hex、t = Date.now()）；bracketed paste 里的一整段另记 kind: paste（text 原文）。
// - 打字回显；回车提交一行（paste 里的回车不算）：colors 画颜色和框线，bell 发 BEL、经 tmux 透传的 OSC 9、不透传的 OSC 9，quit 退出，
//   别的画一行 “got: …”。
// 日志：$AGENTDECK_E2E_LOG_DIR/key-probe-<pid>.jsonl（每行带 terminal，测试用 deck.agentLog 读）。只用 node 内置模块。

import { logger, write } from './fake-common.mjs';

const args = process.argv.slice(2);
const log = logger(`key-probe-${process.pid}`);
log({ kind: 'start', argv: args });

/** 颜色和框线（IS-05）：16 色、256 色、真彩色前景和背景、粗体下划线斜体、圆角和直角框线、中文和符号。 */
const COLOR_BLOCK = [
  '\x1b[31mRED\x1b[0m \x1b[32mGREEN\x1b[0m \x1b[33mYELLOW\x1b[0m \x1b[34mBLUE\x1b[0m \x1b[95mBRIGHT-MAGENTA\x1b[0m',
  '\x1b[38;5;202mP202\x1b[0m \x1b[38;2;255;100;0mRGB-FF6400\x1b[0m \x1b[48;2;0;80;160mBG-0050A0\x1b[0m',
  '\x1b[1mBOLD\x1b[0m \x1b[4mUNDER\x1b[0m \x1b[3mITALIC\x1b[0m',
  '╭────────────╮',
  '│ 中文 ▶ ✓ ● │',
  '╰────────────╯',
  '┌──┬──┐ ═══ ║',
  '└──┴──┘',
];

process.stdout.write('\x1b[?2004h');
if (args.includes('--ext')) process.stdout.write('\x1b[>4;2m');
if (args.includes('--mouse')) process.stdout.write('\x1b[?1002h\x1b[?1006h');
write('Key probe (e2e) ready\n> ');

const quit = () => {
  process.stdout.write('\x1b[?2004l\x1b[>4;0m\x1b[?1002l\x1b[?1006l\r\n');
  process.exit(0);
};

/** @param {string} line */
function run(line) {
  log({ kind: 'line', line });
  if (line === 'colors') write(`\n${COLOR_BLOCK.join('\n')}\n`);
  else if (line === 'bell') {
    // 普通响铃；DCS tmux; 包着的 OSC 9（tmux 的 allow-passthrough 交给外层）；不包的 OSC 9（看 tmux 怎么处理）
    process.stdout.write('\x07');
    process.stdout.write('\x1bPtmux;\x1b\x1b]9;key-probe finished\x07\x1b\\');
    process.stdout.write('\x1b]9;key-probe plain\x07');
    write('\nrang the bell\n');
  } else if (line === 'quit') quit();
  else write(`\ngot: ${line}\n`);
  write('> ');
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('latin1');
let line = '';
let pasting = false;
let pasted = '';
process.stdin.on('data', (chunk) => {
  const s = String(chunk);
  log({ kind: 'bytes', hex: Buffer.from(s, 'latin1').toString('hex'), t: Date.now() });
  for (const part of s.split(/(\x1b\[20[01]~)/)) {
    if (part === '\x1b[200~') {
      pasting = true;
      pasted = '';
    } else if (part === '\x1b[201~') {
      pasting = false;
      const text = Buffer.from(pasted, 'latin1').toString('utf8');
      log({ kind: 'paste', text });
      write(`\npasted ${text.split(/\r\n?|\n/).length} line(s)\n> `);
    } else if (pasting) pasted += part;
    else if (part.startsWith('\x1b')) {
      // 转义序列（方向键、Esc、Shift+Enter、鼠标）只记日志，不回显
    } else {
      for (const ch of part) {
        if (ch === '\r') {
          const l = line;
          line = '';
          run(l);
        } else if (ch === '\x7f') line = line.slice(0, -1);
        else if (ch >= ' ') {
          line += ch;
          process.stdout.write(ch);
        }
      }
    }
  }
});
process.stdin.on('end', () => process.exit(0));
