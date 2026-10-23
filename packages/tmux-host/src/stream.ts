// 收 tmux 抄送过来的东西：一个 Unix socket，tmux 那边用 nc -U 连上来。
//   pipe-pane：第一行 “pipe <id>”，之后是窗格程序的原始输出（含转义序列），连接一直开着。
//   pane-died 钩子：一行 “exit <id> <status> <signal>”，发完就断。
// 选 socket + nc 而不是 FIFO 或文件：AgentDeck 退出后 nc 连不上就立刻退出，pipe-pane 随之关掉，
// tmux 不会因为没人读而一直攒着输出；重新打开时再给每个会话接一次 pipe-pane。

import { mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { TerminalId } from '@agentdeck/contracts';

export interface StreamHandlers {
  onPipeData(id: TerminalId, data: string): void;
  /** 这个终端当前的抄送连接断了（会话被结束、服务退出、或者被新的 pipe-pane 替换时不算）。 */
  onPipeEnd(id: TerminalId): void;
  onExit(id: TerminalId, status: string, signal: string): void;
}

export interface StreamServer {
  readonly path: string;
  close(): Promise<void>;
}

/** macOS 的 sun_path 最长 104 字节（含结尾 0），太长 listen 会报 EINVAL（实测）。 */
export const MAX_SOCKET_PATH = 103;

const MAX_HEADER = 256;

export async function startStreamServer(path: string, handlers: StreamHandlers): Promise<StreamServer> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    throw new Error(`tmux-host socket path is too long (${Buffer.byteLength(path)} > ${MAX_SOCKET_PATH} bytes): ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(path); // 上次没正常退出留下的
  } catch {
    // 不存在
  }

  /** 每个终端当前的抄送连接；pipe-pane 重接时旧连接会先断，不能把它当成“这个终端的抄送没了”。 */
  const current = new Map<TerminalId, Socket>();
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let header = '';
    let pipeId: TerminalId | null = null;
    let decoder: StringDecoder | null = null;

    socket.on('data', (chunk: Buffer) => {
      if (decoder !== null && pipeId !== null) {
        const text = decoder.write(chunk);
        if (text) handlers.onPipeData(pipeId, text);
        return;
      }
      // 还在读第一行
      const nl = chunk.indexOf(0x0a);
      if (nl === -1) {
        header += chunk.toString('utf8');
        if (header.length > MAX_HEADER) socket.destroy();
        return;
      }
      header += chunk.subarray(0, nl).toString('utf8');
      const rest = chunk.subarray(nl + 1);
      const parts = header.split(' ');
      if (parts[0] === 'pipe' && parts[1]) {
        pipeId = parts[1] as TerminalId;
        decoder = new StringDecoder('utf8');
        current.set(pipeId, socket);
        if (rest.length > 0) {
          const text = decoder.write(rest);
          if (text) handlers.onPipeData(pipeId, text);
        }
      } else if (parts[0] === 'exit' && parts[1]) {
        handlers.onExit(parts[1] as TerminalId, parts[2] ?? '', parts[3] ?? '');
        socket.end();
      } else {
        socket.destroy();
      }
    });
    socket.on('error', () => {
      // nc 被杀掉之类，按断开处理
    });
    socket.on('close', () => {
      sockets.delete(socket);
      if (pipeId !== null && current.get(pipeId) === socket) {
        current.delete(pipeId);
        const tail = decoder?.end();
        if (tail) handlers.onPipeData(pipeId, tail);
        handlers.onPipeEnd(pipeId);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          try {
            unlinkSync(path);
          } catch {
            // 已经没了
          }
          resolve();
        });
      }),
  };
}
