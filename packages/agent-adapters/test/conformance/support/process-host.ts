// L1 用的最小 TerminalHost：真的起子进程（没有 tty），给 K17 用：假程序遇到不认识的参数就退出，看 AgentService 能不能只带会话参数重开。
// 只有 create / kill / lastLines 和 terminal.exit 事件。

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { CreateTerminalRequest, TerminalEvent, TerminalHost, TerminalId } from '@agentdeck/contracts';

export class ProcessHost implements Pick<TerminalHost, 'create' | 'kill' | 'lastLines'> {
  readonly created: CreateTerminalRequest[] = [];
  private n = 0;
  private readonly procs = new Map<TerminalId, { child: ChildProcess; output: string }>();

  constructor(
    private readonly env: Record<string, string>,
    private readonly onEvent: (e: TerminalEvent) => void,
  ) {}

  async create(req: CreateTerminalRequest): Promise<{ id: TerminalId }> {
    const id = `proc-${++this.n}` as TerminalId;
    this.created.push(req);
    const child = spawn(req.cmd, req.args, { env: { ...this.env, ...req.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const p = { child, output: '' };
    child.stdout?.on('data', (d: Buffer) => (p.output += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (p.output += d.toString('utf8')));
    child.on('exit', (code) => this.onEvent({ type: 'terminal.exit', id, code: code ?? 1 }));
    this.procs.set(id, p);
    return { id };
  }

  async kill(id: TerminalId): Promise<void> {
    this.procs.get(id)?.child.kill();
  }

  async lastLines(id: TerminalId, n: number): Promise<string[]> {
    return (this.procs.get(id)?.output ?? '').split('\n').filter(Boolean).slice(-n);
  }

  alive(id: TerminalId): boolean {
    const c = this.procs.get(id)?.child;
    return !!c && c.exitCode === null && c.signalCode === null;
  }

  dispose(): void {
    for (const { child } of this.procs.values()) child.kill();
  }
}
