#!/usr/bin/env node
// agentdeck <command> [args]（M8 · CR15，需求见设计画布“Agent 集群”页 C7）
//
// agent 在 AgentDeck 终端的 shell 里跑的命令：每次现读 api.json 找主进程的地址，带上 AGENTDECK_TERM 和 AGENTDECK_TERM_KEY
// 发一个 CliRequest 到 /cli（和 MCP 同一个服务，packages/mcp-server 的 cli.ts），把 CliResponse 打出来。
// - 成功：stdout 一段 JSON（CliResponse），退出码 0。
// - 出错：stderr 第一行是英文原因，第二行是 JSON，退出码 1（不在 AgentDeck 终端里、找不到 AgentDeck 是 2）。
// - 长内容（交接提示词、消息）从 stdin 读：`agentdeck session open --agent codex < prompt.md`。
// 谁能跑哪条由服务端判断（contracts 的 cliCommandAllowed），这里只拼请求。
//
// 只用 node 内置模块、不 import contracts（运行时没有 TypeScript），常量和 contracts 保持一致，test/cli.test.ts 会核对。

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 和 contracts 的 TERMINAL_ID_ENV 一致。 */
export const TERMINAL_ID_ENV = 'AGENTDECK_TERM';
/** 和 contracts 的 TERMINAL_KEY_ENV 一致。 */
export const TERMINAL_KEY_ENV = 'AGENTDECK_TERM_KEY';
/** 和 contracts 的 API_ENDPOINT_FILE 一致（相对用户主目录）。 */
export const API_ENDPOINT_FILE = '.agentdeck/run/api.json';
/** 和 contracts 的 CLI_PATH 一致。 */
export const CLI_PATH = '/cli';
/** 和 contracts 的 MCP_TERMINAL_HEADER 一致。 */
export const TERMINAL_HEADER = 'x-agentdeck-terminal';
/** 包装脚本（apps/desktop 写的 <数据目录>/bin/agentdeck）用它指向这个 AgentDeck 写的 api.json；测试也用。 */
export const API_FILE_ENV = 'AGENTDECK_API_FILE';
/** 带子命令的组：第二个词是子命令（'crew status'）。open、notify 后面直接是参数；help 的第二个词是要看的组。 */
export const GROUPS_WITH_VERBS = ['crew', 'session', 'doc', 'flow', 'lesson', 'run', 'job', 'out', 'forge', 'help'];
/** stdin 是管道但一直没人写（agent 的 shell 工具有时给一个不关的管道）时，等多久就当没有。 */
const STDIN_IDLE_MS = 1500;
/** 一次最多读多少 stdin（和服务端的请求体上限一致）。 */
const MAX_STDIN_BYTES = 1024 * 1024 - 64 * 1024;

/**
 * @typedef {{ v: 1, url?: string, socket?: string, version: string }} ApiEndpointFile
 * @typedef {{ v: 1, command: string, args: string[], stdin?: string }} CliRequest
 * @typedef {{ code: string, message: string, detail?: string }} ErrorData
 * @typedef {{ ok: true, data?: unknown } | { ok: false, error: ErrorData }} CliResponse
 * @typedef {{ stdout: (s: string) => void, stderr: (s: string) => void }} Output
 */

class CliFailure extends Error {
  /**
   * @param {string} message
   * @param {number} exitCode
   * @param {string} [code]
   */
  constructor(message, exitCode, code = 'invalid-argument') {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
  }
}

/**
 * 命令行参数 → command 和 args。没有参数、--help、-h 是 help。
 * @param {string[]} argv
 * @returns {{ command: string, args: string[] }}
 */
export function toRequest(argv) {
  const isHelp = (/** @type {string | undefined} */ a) => a === '--help' || a === '-h';
  const [group, ...rest] = argv;
  if (group === undefined || isHelp(group)) return { command: 'help', args: [] };
  if (!GROUPS_WITH_VERBS.includes(group)) return { command: group, args: rest };
  const [verb, ...args] = rest;
  if (verb === undefined) return { command: group, args: [] };
  if (isHelp(verb)) return { command: `${group} help`, args: [] };
  if (verb.startsWith('-')) return { command: group, args: rest };
  return { command: `${group} ${verb}`, args };
}

/**
 * 读 api.json。先看 AGENTDECK_API_FILE，再看 ~/.agentdeck/run/api.json。
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ api: ApiEndpointFile, path: string }>}
 */
export async function readApiFile(env) {
  const path = env[API_FILE_ENV] || join(env.HOME || homedir(), API_ENDPOINT_FILE);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new CliFailure(`AgentDeck isn’t running (no ${path})`, 2, 'not-found');
  }
  /** @type {Partial<ApiEndpointFile>} */
  let api;
  try {
    api = JSON.parse(text);
  } catch {
    throw new CliFailure(`Can’t read ${path}`, 2, 'internal');
  }
  if (api.v !== 1 || (typeof api.url !== 'string' && typeof api.socket !== 'string')) throw new CliFailure(`Can’t read ${path}`, 2, 'internal');
  return { api: /** @type {ApiEndpointFile} */ (api), path };
}

/**
 * 发请求。地址按 api.json：有 socket 走 unix socket，否则走 url（http://127.0.0.1:<端口>）。同一个 HTTP 协议，调用方不用管。
 * @param {ApiEndpointFile} api
 * @param {{ terminalId: string, key: string }} who
 * @param {CliRequest} body
 * @returns {Promise<{ status: number, response: CliResponse | null }>}
 */
export function post(api, who, body) {
  const payload = Buffer.from(JSON.stringify(body));
  /** @type {import('node:http').RequestOptions} */
  const target = api.socket ? { socketPath: api.socket, path: CLI_PATH } : urlTarget(/** @type {string} */ (api.url));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...target,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          authorization: `Bearer ${who.key}`,
          [TERMINAL_HEADER]: who.terminalId,
        },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let response = null;
          try {
            response = JSON.parse(text);
          } catch {
            // 不是 JSON（例如别的程序占了这个端口）：交给调用方按状态码报
          }
          resolve({ status: res.statusCode ?? 0, response });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * @param {string} url
 * @returns {import('node:http').RequestOptions}
 */
function urlTarget(url) {
  const u = new URL(url);
  return { host: u.hostname, port: u.port, path: `${u.pathname.replace(/\/$/, '')}${CLI_PATH}` };
}

/**
 * stdin 不是终端时读进来（管道、重定向的文件）。管道开着一直没有数据时不死等。
 * @param {NodeJS.ReadStream} stdin
 * @returns {Promise<string | undefined>}
 */
export function readStdin(stdin = process.stdin) {
  return new Promise((resolve) => {
    if (stdin.isTTY) {
      resolve(undefined);
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let got = false;
    const done = () => {
      clearTimeout(idle);
      stdin.pause();
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(got && text.length > 0 ? text : undefined);
    };
    const idle = setTimeout(() => {
      if (!got) done();
    }, STDIN_IDLE_MS);
    stdin.on('data', (c) => {
      got = true;
      size += c.length;
      if (size <= MAX_STDIN_BYTES) chunks.push(Buffer.from(c));
    });
    stdin.on('end', done);
    stdin.on('error', done);
  });
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {{ out?: Output, stdin?: () => Promise<string | undefined> }} [io]
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const out = io.out ?? { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  /** @param {ErrorData} error */
  const printError = (error) => out.stderr(`${error.message}\n${JSON.stringify({ ok: false, error })}\n`);
  try {
    const terminalId = env[TERMINAL_ID_ENV];
    const key = env[TERMINAL_KEY_ENV];
    if (!terminalId || !key) throw new CliFailure('Not in an AgentDeck terminal: agentdeck only works in terminals AgentDeck opened.', 2);
    const { api } = await readApiFile(env);
    const { command, args } = toRequest(argv);
    const stdin = await (io.stdin ?? (() => readStdin()))();
    /** @type {CliRequest} */
    const body = { v: 1, command, args, ...(stdin !== undefined ? { stdin } : {}) };
    let res;
    try {
      res = await post(api, { terminalId, key }, body);
    } catch {
      throw new CliFailure(`Can’t reach AgentDeck at ${api.socket ?? api.url}. Is it running?`, 2, 'not-found');
    }
    if (!res.response) throw new CliFailure(res.status === 401 ? 'Unauthorized' : `AgentDeck answered ${res.status}`, 1, 'internal');
    if (!res.response.ok) {
      printError(res.response.error);
      return 1;
    }
    out.stdout(`${JSON.stringify(res.response, null, 2)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof CliFailure) {
      printError({ code: e.code, message: e.message });
      return e.exitCode;
    }
    printError({ code: 'internal', message: e instanceof Error ? e.message : String(e) });
    return 1;
  }
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// 直接运行时才执行（测试会 import 这个文件）。bin 可能是软链接，所以先 realpath。
// 退出前等 stdout、stderr 写完（macOS 上写管道是异步的，直接 exit 会截掉输出）。
if (invokedDirectly()) {
  main().then(
    (code) => {
      let pending = 2;
      const finish = () => {
        if (--pending === 0) process.exit(code);
      };
      process.stdout.write('', finish);
      process.stderr.write('', finish);
    },
    () => process.exit(1),
  );
}
