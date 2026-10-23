// 本地演示：把真的 tmux-host 通过 HTTP 交给终端窗口的 dev 页面（packages/ui/widgets/terminal，?real=1）。
// 只在本机 127.0.0.1 上听，给开发用，不是产品的一部分（产品里走 utilityProcess + MessagePort，见 AGENTS.md「给组装」）。
//
//   pnpm --filter @agentdeck/tmux-host dev:bridge          # 用 tmux -L agentdeck-dev，Ctrl+C 退出时会话留着
//   AGENTDECK_BRIDGE_KILL=1 pnpm --filter @agentdeck/tmux-host dev:bridge   # 退出时 kill-server
//
// 接口：
//   GET  /bridge/events  SSE，每条 data 是 {"kind":"event","event":TerminalEvent} 或 {"kind":"data","message":TerminalDataMessage}
//   POST /bridge/call    {"service":"terminals"|"agents"|"app","method":"…","args":[…]} → {"result":…} 或 {"error":AgentDeckErrorData}
//
// agents.start 只是演示用的最小实现（claude 带 --session-id、codex、Shell、自定义命令），真正的在 packages/agent-adapters。
// 链接识别（port-watch）不能从这里 import（服务包之间不互相依赖），所以这里不发 terminal.link；终端窗口自己会给屏幕上的链接画下划线。

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { AgentDeckError, isAgentDeckErrorData, type StartAgentRequest, type TerminalId } from '@agentdeck/contracts';
import { startTmuxHost, type TmuxHost } from '../src/index.ts';

const PORT = Number(process.env.AGENTDECK_BRIDGE_PORT ?? 5341);
const SOCKET = process.env.AGENTDECK_BRIDGE_SOCKET ?? 'agentdeck-dev';

/** 读登录 shell 的环境（产品里由 apps/desktop 做，见 docs/decisions.md）。用干净的环境起 shell，免得带上宿主的变量。 */
function loginEnv(): Promise<Record<string, string>> {
  const shell = process.env.SHELL ?? '/bin/zsh';
  const base: Record<string, string> = {};
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'PATH']) if (process.env[k]) base[k] = process.env[k]!;
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', 'env -0'], { env: base, timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) {
        console.warn(`[bridge] could not read the login shell env (${err?.message ?? 'empty'}), using the current one`);
        resolve({ ...base, LANG: process.env.LANG ?? 'en_US.UTF-8' });
        return;
      }
      const env: Record<string, string> = {};
      for (const entry of stdout.split('\0')) {
        const i = entry.indexOf('=');
        if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
      }
      resolve(env);
    });
  });
}

const clients = new Set<ServerResponse>();
/** 页面接上的显示连接。页面刷新或关掉时（SSE 断开、没有别的页面）全部 detach，和组装时“窗口关了就 detach 它的 view”一样。 */
const views = new Set<string>();
function broadcast(payload: unknown): void {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) c.write(line);
}

const env = await loginEnv();
let host: TmuxHost;
try {
  host = await startTmuxHost({
    env,
    socketName: SOCKET,
    onEvent: (event) => broadcast({ kind: 'event', event }),
    onData: (message) => broadcast({ kind: 'data', message }),
  });
} catch (e) {
  console.error(`[bridge] ${e instanceof Error ? e.message : String(e)}`, isAgentDeckErrorData(e) ? (e.detail ?? '') : '');
  process.exit(1);
}

async function startAgent(req: StartAgentRequest): Promise<unknown> {
  const terminalId = `t-${randomUUID().slice(0, 12)}` as TerminalId;
  let cmd: string;
  let args: string[];
  let sessionId: string | null = null;
  const shell = env.SHELL ?? '/bin/zsh';
  switch (req.agent) {
    case 'claude':
      cmd = 'claude';
      if (req.mode.kind === 'resume') {
        sessionId = req.mode.sessionId;
        args = ['--resume', sessionId];
      } else {
        sessionId = randomUUID();
        args = ['--session-id', sessionId];
      }
      break;
    case 'codex':
      cmd = 'codex';
      args = req.mode.kind === 'resume' ? ['resume', req.mode.sessionId] : [];
      break;
    case 'shell':
      cmd = shell;
      args = req.command ? ['-lc', req.command] : ['-l'];
      break;
    default: {
      const parts = (req.command ?? String(req.agent)).trim().split(/\s+/);
      cmd = parts[0] ?? '';
      args = parts.slice(1);
    }
  }
  await host.create({
    id: terminalId,
    cmd,
    args,
    cwd: req.cwd === '~' ? (env.HOME ?? '/') : req.cwd,
    ...(req.size ? { size: req.size } : {}),
    env: req.agent === 'claude' ? { CLAUDE_CODE_TMUX_TRUECOLOR: '1' } : {},
  });
  return { terminalId, sessionId, cmd, args };
}

async function call(service: string, method: string, args: unknown[]): Promise<unknown> {
  if (service === 'terminals') {
    const fn = (host as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function' || !['create', 'kill', 'list', 'attach', 'detach', 'write', 'resize', 'sendKeys', 'lastLines', 'attachCommand', 'recentLinks'].includes(method)) {
      throw new AgentDeckError({ code: 'invalid-argument', message: `Unknown method terminals.${method}` });
    }
    const result = await (fn as (...a: unknown[]) => unknown).apply(host, args);
    if (method === 'attach') views.add((result as { viewId: string }).viewId);
    if (method === 'detach') views.delete(String(args[0]));
    return result;
  }
  if (service === 'agents' && method === 'start') return startAgent(args[0] as StartAgentRequest);
  if (service === 'app' && method === 'openInSystemTerminal') {
    const cmd = await host.attachCommand(args[0] as TerminalId);
    console.log(`[bridge] open in system terminal: ${cmd}`);
    return null;
  }
  if (service === 'app' && method === 'openInEditor') {
    console.log(`[bridge] open in editor: ${String(args[0])}${args[1] === undefined ? '' : `:${String(args[1])}`}`);
    return null;
  }
  throw new AgentDeckError({ code: 'invalid-argument', message: `Unknown method ${service}.${method}` });
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/bridge/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => {
      clients.delete(res);
      if (clients.size > 0) return;
      for (const v of views) void host.detach(v as never);
      views.clear();
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/bridge/call') {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      let parsed: { service: string; method: string; args: unknown[] };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        send(400, { error: { code: 'invalid-argument', message: 'Bad JSON' } });
        return;
      }
      call(parsed.service, parsed.method, parsed.args ?? [])
        .then((result) => send(200, { result: result ?? null }))
        .catch((e: unknown) => {
          const data = e instanceof AgentDeckError ? e.toData() : isAgentDeckErrorData(e) ? e : { code: 'internal', message: e instanceof Error ? e.message : String(e) };
          send(200, { error: data });
        });
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] ${host.tmuxVersion}, tmux -L ${SOCKET}; listening on http://127.0.0.1:${PORT}/bridge`);
  console.log('[bridge] open http://localhost:5340/?real=1 (pnpm --filter @agentdeck/ui-widget-terminal dev)');
});

const shutdown = async () => {
  server.close();
  for (const c of clients) c.end();
  if (process.env.AGENTDECK_BRIDGE_KILL === '1') await host.killServer();
  await host.dispose();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
