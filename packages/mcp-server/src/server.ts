// MCP 的 HTTP 服务，跑在主进程，只听 127.0.0.1。同一个端口上还有 agentdeck 命令行的 POST /cli（CR14，见 cli.ts）。
// 无状态（不发 Mcp-Session-Id）：每个请求新建一个 McpServer 和 transport，AgentDeck 重启后 agent 的下一次调用照常能用，
// 不需要重新握手。调用者是哪个终端看请求头 MCP_TERMINAL_HEADER，用终端钥匙核对（IS-101，见 terminalKey）。

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { CLI_PATH, CONTRACTS_VERSION, MCP_SERVER_NAME, MCP_TERMINAL_HEADER } from '@agentdeck/contracts';
import type { ApiEndpointFile, CliRequest, CliResponse, McpEndpoint, TerminalId } from '@agentdeck/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { handleCli } from './cli.ts';
import type { CliDeps } from './cli.ts';
import { LEAD_ONLY_TOOLS, registerTools, SERVER_INSTRUCTIONS } from './tools.ts';
import type { McpToolDeps } from './tools.ts';

/** 固定端口：AgentDeck 重启后还活着的 agent（tmux 里）靠它连回来。被占用时换一个随机端口，那些 agent 要重开才能用。 */
export const DEFAULT_MCP_PORT = 47621;
const PATH = '/mcp';
/** 一个请求体最大多少字节。 */
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpHttpServerOptions extends McpToolDeps, CliDeps {
  /** AgentDeck 的密钥（mcp-token）。终端钥匙由它算（terminalKey）；它本身只留一个版本给已经开着的终端用（IS-101）。 */
  token: string;
  /** 默认 DEFAULT_MCP_PORT；0 表示随机。 */
  port?: number;
  version?: string;
  /**
   * CR14：命令行找服务的文件（contracts 的 ApiEndpointFile，默认位置 ~/API_ENDPOINT_FILE）。给了就在起来后写上地址，
   * 关掉时删掉（还是自己写的那份时）。组装时放在数据目录的 run/api.json，命令行的包装脚本用 AGENTDECK_API_FILE 指过去。
   */
  apiFile?: string;
  onError?: (error: unknown) => void;
}

export interface McpHttpServer {
  /** 挂到 agent 上的地址和共用 token（LaunchContext.mcp）。启动终端时 token 换成这个终端的钥匙（keyFor）。 */
  readonly endpoint: McpEndpoint;
  readonly port: number;
  /** 命令行的地址（api.json 的 url）：http://127.0.0.1:<port>，请求发到它 + CLI_PATH。 */
  readonly apiUrl: string;
  /** 这个终端的钥匙（AGENTDECK_TERM_KEY），同 terminalKey(token, id)。 */
  keyFor(terminalId: TerminalId): string;
  close(): Promise<void>;
}

/**
 * IS-101：每个终端一把钥匙 = HMAC-SHA256(AgentDeck 的密钥, 终端 id)，十六进制。开终端时放进它的环境（AGENTDECK_TERM_KEY，
 * 也当 MCP 的 Bearer），不进命令行。只知道自己钥匙的 agent 把终端 id 改成别人的也过不了；从钥匙推不出密钥。
 */
export function terminalKey(token: string, terminalId: string): string {
  return createHmac('sha256', token).update(terminalId).digest('hex');
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
  const apiUrl = `http://127.0.0.1:${port}`;
  const api: ApiEndpointFile = { v: 1, url: apiUrl, version: CONTRACTS_VERSION };
  if (opts.apiFile) {
    try {
      await writeApiFile(opts.apiFile, api);
    } catch (e) {
      http.close();
      throw e;
    }
  }
  return {
    endpoint: { url: `${apiUrl}${PATH}`, token: opts.token },
    port,
    apiUrl,
    keyFor: (id) => terminalKey(opts.token, id),
    close: async () => {
      await new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      });
      if (opts.apiFile) await removeApiFileIfOurs(opts.apiFile, apiUrl);
    },
  };
}

/** 写 api.json：先写临时文件再改名，命令行不会读到半个文件。目录只有自己能进。 */
async function writeApiFile(path: string, api: ApiEndpointFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(api)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** 关掉时删 api.json，但只删自己写的（换了端口重开的新服务已经写了新的就不动）。 */
async function removeApiFileIfOurs(path: string, url: string): Promise<void> {
  const current = await readFile(path, 'utf8').then(
    (t) => (JSON.parse(t) as Partial<ApiEndpointFile>).url,
    () => undefined,
  );
  if (current === url) await rm(path, { force: true });
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
  if (url.pathname !== PATH && url.pathname !== CLI_PATH) return reply(res, 404, 'Not found');
  // 网页不能调：浏览器的请求总带 Origin；Host 不是本机时可能是 DNS rebinding。
  if (req.headers.origin !== undefined) return reply(res, 403, 'Forbidden');
  if (!isLoopbackHost(req.headers.host)) return reply(res, 403, 'Forbidden');
  if (url.pathname === CLI_PATH) return handleCliHttp(req, res, opts);

  const auth = authenticate(req.headers.authorization, req.headers[MCP_TERMINAL_HEADER], opts.token, { shared: true });
  if (!auth) return reply(res, 401, 'Unauthorized');
  // 无状态服务没有服务端推送的长连接，也没有会话可删（规范允许 GET 回 405）。
  if (req.method !== 'POST') return reply(res, 405, 'Method not allowed', { Allow: 'POST' });

  const body = await readJson(req);
  if (body === TOO_LARGE) return reply(res, 413, 'Payload too large');

  const server = new McpServer({ name: MCP_SERVER_NAME, version: opts.version ?? '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, opts, { terminalId: auth.terminalId }, { omit: await hiddenTools(auth.terminalId, opts) });
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true }) // 不给 sessionIdGenerator 就是无状态;
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/**
 * agentdeck 命令行：POST /cli，body 是 CliRequest，回 CliResponse（JSON）。只认终端钥匙（不收共用 token：
 * 开着的老终端 PATH 里本来就没有这个命令）。钥匙对不上终端 id 时 401，body 也是 CliResponse，命令行照样打第一行。
 */
async function handleCliHttp(req: IncomingMessage, res: ServerResponse, opts: McpHttpServerOptions): Promise<void> {
  const auth = authenticate(req.headers.authorization, req.headers[MCP_TERMINAL_HEADER], opts.token, { shared: false });
  if (!auth?.terminalId) return replyJson(res, 401, { ok: false, error: { code: 'invalid-argument', message: 'Unauthorized' } });
  if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: { code: 'invalid-argument', message: 'Use POST' } }, { Allow: 'POST' });
  const body = await readJson(req);
  if (body === TOO_LARGE) return replyJson(res, 413, { ok: false, error: { code: 'invalid-argument', message: 'Input too large' } });
  const request = asCliRequest(body);
  if (!request) return replyJson(res, 400, { ok: false, error: { code: 'invalid-argument', message: 'Not a CliRequest' } });
  replyJson(res, 200, await handleCli(request, auth.terminalId, opts));
}

function asCliRequest(body: unknown): CliRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Partial<CliRequest>;
  if (b.v !== 1 || typeof b.command !== 'string') return null;
  if (!Array.isArray(b.args) || !b.args.every((x) => typeof x === 'string')) return null;
  if (b.stdin !== undefined && typeof b.stdin !== 'string') return null;
  return { v: 1, command: b.command, args: b.args, ...(b.stdin !== undefined ? { stdin: b.stdin } : {}) };
}

/** 集群里不是 Lead 的终端看不到 LEAD_ONLY_TOOLS（CR14、DR-72）。没有 CrewService、它出错时不藏（集群还不存在）。 */
async function hiddenTools(terminalId: TerminalId | null, opts: McpHttpServerOptions): Promise<ReadonlySet<string>> {
  const crew = terminalId ? (opts.crew?.() ?? null) : null;
  if (!crew || !terminalId) return new Set();
  try {
    const m = await crew.membership(terminalId);
    return m && m.role !== 'lead' ? LEAD_ONLY_TOOLS : new Set();
  } catch (e) {
    opts.onError?.(e);
    return new Set();
  }
}

/** 配置里写的是 `${AGENTDECK_TERM}`；环境里没有这个变量时 claude 原样发来，当成不在 AgentDeck 的终端里。 */
function callerTerminal(raw: string | string[] | undefined): TerminalId | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || v.includes('${')) return null;
  return v as TerminalId;
}

/**
 * 认调用者：Bearer 是请求头里那个终端的钥匙 → 就是这个终端（key）。shared 时也收共用 token（shared），
 * 这时终端 id 只看请求头（老版本开的终端，环境里是共用 token；留一个版本，IS-101）。都不对返回 null。
 */
function authenticate(
  authorization: string | undefined,
  terminalHeader: string | string[] | undefined,
  token: string,
  opts: { shared: boolean },
): { terminalId: TerminalId | null; via: 'key' | 'shared' } | null {
  const bearer = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
  if (!bearer) return null;
  const terminalId = callerTerminal(terminalHeader);
  if (terminalId && sameText(bearer, terminalKey(token, terminalId))) return { terminalId, via: 'key' };
  if (opts.shared && sameText(bearer, token)) return { terminalId, via: 'shared' };
  return null;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
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

function replyJson(res: ServerResponse, status: number, body: CliResponse, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
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
