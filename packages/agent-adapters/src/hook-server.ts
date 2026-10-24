// 钩子 socket 的服务端，跑在主进程。agentdeck-notify 每次钩子连一次，发一行 HookEnvelope；
// 这里交给对应适配器的 parseHook，产出统一事件；PermissionRequest 这类要回答的，回一行 HookReply。

import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOOK_SOCKET } from '@agentdeck/contracts';
import type { AgentAdapter, AgentHookEvent, AgentKind, HookEnvelope, HookReply, TerminalId } from '@agentdeck/contracts';

export interface ReceivedHook {
  terminalId: TerminalId;
  agent: AgentKind;
  hookName: string;
  /** 适配器认不出时为 null（仍然交给 onHook，方便记日志）。 */
  event: AgentHookEvent | null;
  envelope: HookEnvelope;
  /**
   * 要回答的钩子（envelope.expectsReply）回了什么，而且回答确实写给了 agentdeck-notify。
   * 'allow' 表示 agent 会直接放行（Auto-approve），这条请求不该再让终端进 needs-approval。不要回答的钩子没有这个字段。
   */
  decision?: HookReply['decision'];
}

export interface HookServerOptions {
  /** 默认 ~/.agentdeck/run/hooks.sock。测试用临时目录。 */
  socketPath?: string;
  adapterFor: (agent: AgentKind) => Pick<AgentAdapter, 'parseHook'> | undefined;
  onHook: (hook: ReceivedHook) => void;
  /**
   * 要回答的钩子怎么答。不给时一律 none（照常显示 agent 自己的确认）。
   * runtime 接的是 ApprovalServiceImpl.decide：终端或它的框开了 Auto-approve 且不是破坏性命令时返回 allow。
   * 先回答、再调 onHook（onHook 能从 ReceivedHook.decision 知道回了什么）。要快：notify 只等 2 秒。
   */
  decide?: (hook: ReceivedHook) => HookReply['decision'] | Promise<HookReply['decision']>;
  /** 收到坏数据时（不是 JSON、版本不对）。默认忽略。 */
  onBadMessage?: (line: string, reason: string) => void;
}

/** 一行最长多少字节。钩子负载里可能有很长的命令或文件内容，但不会无限长。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export function defaultHookSocketPath(home = homedir()): string {
  return join(home, HOOK_SOCKET);
}

export class HookServer {
  readonly socketPath: string;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly opts: HookServerOptions) {
    this.socketPath = opts.socketPath ?? defaultHookSocketPath();
  }

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    // 上次没正常退出会留下 socket 文件，不删就 listen 不上。Electron 有单实例锁，不会有两个 AgentDeck 抢。
    await unlink(this.socketPath).catch(() => undefined);
    const server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    // 只有自己能连：别的用户能连上就能伪造“需要批准”。
    await chmod(this.socketPath, 0o600).catch(() => undefined);
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.socketPath).catch(() => undefined);
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_LINE_BYTES) {
        this.opts.onBadMessage?.(buffer.slice(0, 200), 'line too long');
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) void this.handleLine(socket, line);
      }
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    const envelope = parseEnvelope(line);
    if (typeof envelope === 'string') {
      this.opts.onBadMessage?.(line, envelope);
      return;
    }
    const adapter = this.opts.adapterFor(envelope.agent);
    let event: AgentHookEvent | null;
    try {
      event = adapter?.parseHook(envelope.hookName, envelope.payload) ?? null;
    } catch {
      event = null;
    }
    const hook: ReceivedHook = {
      terminalId: envelope.terminalId,
      agent: envelope.agent,
      hookName: envelope.hookName,
      event,
      envelope,
    };
    if (!envelope.expectsReply) {
      this.opts.onHook(hook);
      return;
    }
    let decision: HookReply['decision'];
    try {
      decision = (await this.opts.decide?.(hook)) ?? 'none';
    } catch {
      decision = 'none';
    }
    // notify 已经走了（超时、agent 被打断）：回答送不到，agent 会照常显示确认框，按 none 算
    if (socket.destroyed || !socket.writable) decision = 'none';
    else {
      const reply: HookReply = { v: 1, decision };
      socket.write(`${JSON.stringify(reply)}\n`);
    }
    this.opts.onHook({ ...hook, decision });
  }
}

/** 校验一行 HookEnvelope。不合格返回原因。 */
export function parseEnvelope(line: string): HookEnvelope | string {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return 'not JSON';
  }
  const e = v as Partial<HookEnvelope> | null;
  if (!e || typeof e !== 'object') return 'not an object';
  if (e.v !== 1) return `unsupported version ${String(e.v)}`;
  if (typeof e.terminalId !== 'string' || !e.terminalId) return 'missing terminalId';
  if (typeof e.agent !== 'string' || !e.agent) return 'missing agent';
  if (typeof e.hookName !== 'string' || !e.hookName) return 'missing hookName';
  return {
    v: 1,
    terminalId: e.terminalId,
    agent: e.agent,
    hookName: e.hookName,
    payload: e.payload ?? null,
    at: typeof e.at === 'string' ? e.at : new Date().toISOString(),
    expectsReply: e.expectsReply === true,
  };
}
