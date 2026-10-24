// MCP 的 HTTP 服务，跑在主进程，只听 127.0.0.1。
// 无状态（不发 Mcp-Session-Id）：每个请求新建一个 McpServer 和 transport，AgentDeck 重启后 agent 的下一次调用照常能用，
// 不需要重新握手。调用者靠请求头里的终端 id 认出来，见 contracts 的 MCP_TERMINAL_HEADER。

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { MCP_SERVER_NAME, MCP_TERMINAL_HEADER } from '@agentdeck/contracts';
import type { McpEndpoint, TerminalId } from '@agentdeck/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.ts';
import type { McpToolDeps } from './tools.ts';

/** 固定端口：AgentDeck 重启后还活着的 agent（tmux 里）靠它连回来。被占用时换一个随机端口，那些 agent 要重开才能用。 */
export const DEFAULT_MCP_PORT = 47621;
const PATH = '/mcp';
/** 一个请求体最大多少字节。 */
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpHttpServerOptions extends McpToolDeps {
  token: string;
  /** 默认 DEFAULT_MCP_PORT；0 表示随机。 */
  port?: number;
  version?: string;
  onError?: (error: unknown) => void;
}

export interface McpHttpServer {
  /** 挂到 agent 上的地址和 token（LaunchContext.mcp）。 */
  readonly endpoint: McpEndpoint;
  readonly port: number;
  close(): Promise<void>;
}

export async function startMcpServer(opts: McpHttpServerOptions): Promise<McpHttpServer> {
  const http = createServer((req, res) => {
    handle(req, res, opts).catch((e: unknown) => {
      opts.onError?.(e);
      if (!res.headersSent) reply(res, 500, 'Internal error');
      else res.end();
    });
  });
  const port = await listen(http, opts.port ?? DEFAULT_MCP_PORT).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || opts.port === 0) throw e;
    return listen(http, 0);
  });
  return {
    endpoint: { url: `http://127.0.0.1:${port}${PATH}`, token: opts.token },
    port,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

function listen(http: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    http.once('error', onError);
    http.listen(port, '127.0.0.1', () => {
      http.off('error', onError);
      resolve((http.address() as AddressInfo).port);
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: McpHttpServerOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== PATH) return reply(res, 404, 'Not found');
  // 网页不能调：浏览器的请求总带 Origin；Host 不是本机时可能是 DNS rebinding。
  if (req.headers.origin !== undefined) return reply(res, 403, 'Forbidden');
  if (!isLoopbackHost(req.headers.host)) return reply(res, 403, 'Forbidden');
  if (!checkToken(req.headers.authorization, opts.token)) return reply(res, 401, 'Unauthorized');
  // 无状态服务没有服务端推送的长连接，也没有会话可删（规范允许 GET 回 405）。
  if (req.method !== 'POST') return reply(res, 405, 'Method not allowed', { Allow: 'POST' });

  const body = await readJson(req);
  if (body === TOO_LARGE) return reply(res, 413, 'Payload too large');

  const server = new McpServer({ name: MCP_SERVER_NAME, version: opts.version ?? '0.1.0' });
  registerTools(server, opts, { terminalId: callerTerminal(req.headers[MCP_TERMINAL_HEADER]) });
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true }) // 不给 sessionIdGenerator 就是无状态;
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/** 配置里写的是 `${AGENTDECK_TERM}`；环境里没有这个变量时 claude 原样发来，当成不在 AgentDeck 的终端里。 */
function callerTerminal(raw: string | string[] | undefined): TerminalId | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || v.includes('${')) return null;
  return v as TerminalId;
}

function checkToken(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

const TOO_LARGE = Symbol('too large');

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return TOO_LARGE;
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // 交给 transport 回 JSON-RPC 的 parse error
    return text;
  }
}

function reply(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(message);
}

/**
 * 读出 token，没有就生成一个并存下来（只有自己能读）。存下来是为了 AgentDeck 重启后，tmux 里还活着的 agent
 * 环境里的旧 token 仍然有效。
 */
export async function loadOrCreateToken(path: string): Promise<string> {
  const existing = await readFile(path, 'utf8').then(
    (s) => s.trim(),
    () => '',
  );
  if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  const token = randomBytes(32).toString('hex');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return token;
}
