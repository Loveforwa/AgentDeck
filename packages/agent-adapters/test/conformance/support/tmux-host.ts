// L2 用的最小 TerminalHost：单独的 tmux 实例（tmux -L agentdeck-conformance -f /dev/null），不碰用户自己的 tmux 和 AgentDeck 的 agentdeck。
// create / kill / sendKeys / lastLines，加上轮询屏幕得到的 terminal.activity / silence / exit（真 tmux-host 用 monitor-silence 和 pane-died 钩子）。

import { execFileSync } from 'node:child_process';
import type { CreateTerminalRequest, TerminalEvent, TerminalHost, TerminalId } from '@agentdeck/contracts';

export const CONFORMANCE_SOCKET = 'agentdeck-conformance';

export function tmux(...args: string[]): string {
  return execFileSync('tmux', ['-L', CONFORMANCE_SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8' });
}

interface Watch {
  last: string;
  changedAt: number;
  active: boolean;
  dead: boolean;
}

export class ConformanceTmuxHost implements Pick<TerminalHost, 'create' | 'kill' | 'sendKeys' | 'lastLines'> {
  private n = 0;
  private readonly watches = new Map<TerminalId, Watch>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly listeners: ((e: TerminalEvent) => void)[] = [];

  constructor(
    /** 每个窗格都带的环境（hook socket、临时 HOME、假模型的配置目录……）。 */
    private readonly paneEnv: () => Record<string, string>,
    private readonly silenceMs = 3000,
  ) {
    this.timer = setInterval(() => this.poll(), 250);
  }

  on(listener: (e: TerminalEvent) => void): void {
    this.listeners.push(listener);
  }

  async create(req: CreateTerminalRequest): Promise<{ id: TerminalId }> {
    const id = (req.id ?? `conf-${process.pid}-${++this.n}`) as TerminalId;
    const env = { ...this.paneEnv(), ...req.env, AGENTDECK_TERM: id };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    tmux('new-session', '-d', '-s', id, '-x', '160', '-y', '45', '-c', req.cwd, ...envArgs, '--', req.cmd, ...req.args);
    tmux('set-option', '-t', id, 'remain-on-exit', 'on');
    this.watches.set(id, { last: '', changedAt: Date.now(), active: false, dead: false });
    return { id };
  }

  async kill(id: TerminalId): Promise<void> {
    this.watches.delete(id);
    try {
      tmux('kill-session', '-t', id);
    } catch {
      // 已经没了
    }
  }

  async sendKeys(id: TerminalId, keys: string[]): Promise<void> {
    tmux('send-keys', '-t', id, '--', ...keys);
  }

  async lastLines(id: TerminalId, n: number): Promise<string[]> {
    const lines = this.screen(id).split('\n');
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    return lines.slice(-n);
  }

  screen(id: TerminalId): string {
    try {
      return tmux('capture-pane', '-p', '-t', id);
    } catch {
      return '';
    }
  }

  /** 窗格的当前目录（K18）。 */
  cwd(id: TerminalId): string {
    return tmux('display-message', '-p', '-t', id, '#{pane_current_path}').trim();
  }

  /** 像用户一样打字：文字和回车之间停一下（有的 TUI 把紧跟着的回车当成粘贴里的换行）。 */
  async type(id: TerminalId, text: string): Promise<void> {
    tmux('send-keys', '-t', id, '-l', text);
    await new Promise((r) => setTimeout(r, 500));
    tmux('send-keys', '-t', id, 'Enter');
  }

  dispose(): void {
    clearInterval(this.timer);
    try {
      tmux('kill-server');
    } catch {
      // 已经没了
    }
  }

  private emit(e: TerminalEvent): void {
    for (const l of this.listeners) l(e);
  }

  private poll(): void {
    const at = new Date().toISOString();
    for (const [id, w] of this.watches) {
      if (w.dead) continue;
      let info: string;
      try {
        info = tmux('display-message', '-p', '-t', id, '#{pane_dead} #{pane_dead_status}').trim();
      } catch {
        continue;
      }
      const [dead, code] = info.split(' ');
      if (dead === '1') {
        w.dead = true;
        this.emit({ type: 'terminal.exit', id, code: Number(code) || 0 });
        continue;
      }
      const s = this.screen(id);
      if (s !== w.last) {
        w.last = s;
        w.changedAt = Date.now();
        if (!w.active) {
          w.active = true;
          this.emit({ type: 'terminal.activity', id, at });
        }
      } else if (w.active && Date.now() - w.changedAt >= this.silenceMs) {
        w.active = false;
        this.emit({ type: 'terminal.silence', id, at });
      }
    }
  }
}
