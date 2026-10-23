#!/usr/bin/env node
// agentdeck-notify <agent> <hookName> [payload]
//
// agent 的钩子运行这个小命令：从 stdin 读钩子负载（JSON），从环境变量 AGENTDECK_TERM 读终端 id，
// 连 ~/.agentdeck/run/hooks.sock，发一行 HookEnvelope（协议见 packages/contracts/src/agent.ts）。
// PermissionRequest 会等一行 HookReply，2 秒没回按 none 处理。
// 第三个参数是给旧版 codex 的 notify 用的：它把 JSON 放在最后一个命令行参数里，不走 stdin。
//
// 原则：绝不让 agent 卡住或报错。连不上、超时、负载不是 JSON，都安静退出 0，什么也不输出
// （钩子什么也不输出 = agent 照常显示自己的确认）。
//
// 这里只用 node 内置模块、不 import contracts（运行时没有 TypeScript），常量和 contracts 保持一致，
// test/notify.test.ts 会核对。

import { realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 和 contracts 的 HOOK_SOCKET 一致（相对用户主目录）。 */
export const HOOK_SOCKET = '.agentdeck/run/hooks.sock';
/** 和 contracts 的 TERMINAL_ID_ENV 一致。 */
export const TERMINAL_ID_ENV = 'AGENTDECK_TERM';
/** 测试和调试用：覆盖 socket 路径。 */
export const SOCKET_OVERRIDE_ENV = 'AGENTDECK_HOOK_SOCKET';
/** 等 HookReply 的时间。 */
export const REPLY_TIMEOUT_MS = 2000;
/** 读 stdin 的上限。钩子总是会关 stdin，这只是保险。 */
const STDIN_TIMEOUT_MS = 2000;
/** 不等回答的钩子：连上并写完的上限。 */
const SEND_TIMEOUT_MS = 1000;

/**
 * @typedef {{ v: 1, terminalId: string, agent: string, hookName: string, payload: unknown, at: string, expectsReply: boolean }} HookEnvelope
 * @typedef {{ v: 1, decision: 'allow' | 'none' }} HookReply
 */

/**
 * 哪些钩子要等回答。
 * @param {string} agent
 * @param {string} hookName
 */
export function expectsReply(agent, hookName) {
  return (agent === 'claude' || agent === 'codex') && hookName === 'PermissionRequest';
}

/**
 * 把 HookReply 换成 agent 认的钩子输出（写到 stdout）。没有要说的返回 null。
 * claude 和 codex 的 PermissionRequest 输出格式相同。
 */
/**
 * @param {string} agent
 * @param {string} hookName
 * @param {HookReply | null} reply
 * @returns {string | null}
 */
export function replyToStdout(agent, hookName, reply) {
  if (!reply || reply.decision !== 'allow') return null;
  if (expectsReply(agent, hookName)) {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  }
  return null;
}

/** @returns {Promise<string>} */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    const done = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => chunks.push(Buffer.from(c)));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

/** @param {string} text */
function parsePayload(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * 发一行，按需等一行回答。任何失败都返回 null。
 * @param {string} socketPath
 * @param {HookEnvelope} envelope
 * @returns {Promise<HookReply | null>}
 */
function send(socketPath, envelope) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    /** @param {HookReply | null} value */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), envelope.expectsReply ? REPLY_TIMEOUT_MS : SEND_TIMEOUT_MS);
    const sock = connect(socketPath);
    sock.on('error', () => finish(null));
    sock.on('connect', () => {
      sock.write(JSON.stringify(envelope) + '\n', () => {
        if (!envelope.expectsReply) finish(null);
      });
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, nl)));
      } catch {
        finish(null);
      }
    });
    sock.on('close', () => finish(null));
  });
}

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const [agent, hookName, argPayload] = argv;
  if (!agent || !hookName) return;
  const terminalId = env[TERMINAL_ID_ENV];
  // 不在 AgentDeck 的终端里（例如用户在自己的终端里跑同一个会话）：什么也不做。
  if (!terminalId) return;
  const raw = argPayload !== undefined ? argPayload : await readStdin();
  /** @type {HookEnvelope} */
  const envelope = {
    v: 1,
    terminalId,
    agent,
    hookName,
    payload: parsePayload(raw),
    at: new Date().toISOString(),
    expectsReply: expectsReply(agent, hookName),
  };
  const home = env.HOME || homedir();
  const socketPath = env[SOCKET_OVERRIDE_ENV] || join(home, HOOK_SOCKET);
  const reply = await send(socketPath, envelope);
  const out = replyToStdout(agent, hookName, reply);
  if (out) process.stdout.write(out + '\n');
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// 直接运行时才执行（测试会 import 这个文件）。bin 可能是软链接，所以先 realpath。
if (invokedDirectly()) {
  main()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
