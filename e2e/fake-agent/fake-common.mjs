// 假 codex / pi / omp / kimi / 小 TUI 共用的几样东西（g3 的验收用例）：日志、跑钩子命令、画面、按行读键盘（认 bracketed paste）。
// 和 fake-claude.mjs 同样的约定：日志写进 $AGENTDECK_E2E_LOG_DIR/<文件>.jsonl，每行带 terminal（AGENTDECK_TERM），测试用 deck.agentLog 读。
// 只用 node 内置模块。

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} file 日志文件名（不带 .jsonl）
 * @returns {(entry: Record<string, unknown>) => void}
 */
export function logger(file) {
  const dir = process.env['AGENTDECK_E2E_LOG_DIR'];
  return (entry) => {
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${file}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), terminal: process.env['AGENTDECK_TERM'] ?? null, ...entry })}\n`);
    } catch {
      // 只是给测试看的
    }
  };
}

/** 画到终端上（\n 换成 \r\n，raw 模式下要自己回车）。 */
export const write = (/** @type {string} */ s) => process.stdout.write(s.replace(/\r?\n/g, '\r\n'));

/**
 * 跑一条钩子命令（/bin/sh -c，负载走 stdin），返回 stdout。没有命令时直接返回 ''。
 * @param {string | null} command
 * @param {Record<string, unknown>} payload
 * @returns {Promise<string>}
 */
export function runHookCommand(command, payload) {
  return new Promise((resolve) => {
    if (!command) {
      resolve('');
      return;
    }
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString('utf8')));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * 按行读键盘：回车提交一行，退格删字；bracketed paste（ESC[200~ … ESC[201~）里的换行当空格、不提交。
 * onKey 先看每个字符，返回 true 表示它吃掉了（确认框之类）。
 * @param {{ onLine: (line: string) => void, onKey?: (ch: string) => boolean, echo?: boolean, onPaste?: (text: string) => void }} h
 */
export function readLines(h) {
  let line = '';
  let pasting = false;
  let pasted = '';
  const echo = h.echo ?? true;
  /** @param {string} chunk */
  const chars = (chunk) => {
    for (const ch of chunk) {
      if (pasting) {
        pasted += ch;
        const c = ch === '\r' || ch === '\n' ? ' ' : ch;
        line += c;
        if (echo) write(c);
        continue;
      }
      if (h.onKey?.(ch)) continue;
      if (ch === '\x03') process.exit(130);
      else if (ch === '\r' || ch === '\n') {
        const l = line;
        line = '';
        if (echo) write('\n');
        h.onLine(l);
      } else if (ch === '\x7f' || ch === '\b') {
        if (line.length > 0) {
          line = line.slice(0, -1);
          if (echo) write('\b \b');
        }
      } else if (ch >= ' ') {
        line += ch;
        if (echo) write(ch);
      }
    }
  };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    for (const part of String(c).split(/(\x1b\[20[01]~)/)) {
      if (part === '\x1b[200~') {
        pasting = true;
        pasted = '';
      } else if (part === '\x1b[201~') {
        pasting = false;
        h.onPaste?.(pasted);
      } else chars(part);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

/** 一个像 uuid v7 的 id（codex 的会话 id 是 v7）。 */
export function uuid7() {
  const hex = (/** @type {number} */ n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const t = Date.now().toString(16).padStart(12, '0');
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${hex(3)}-8${hex(3)}-${hex(12)}`;
}
