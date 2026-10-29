// AH1：启动后替用户打第一条消息（LaunchSpec.sendAfterReady，kimi 这类交互模式没有带消息参数的 agent）。
// 等终端第一次安静下来（tmux monitor-silence，默认 3 秒没输出）：先看屏幕，没有“还没到输入框”的字（notReadyScreens）就
// 把消息打进去，停一下再按回车（紧跟在一段输入后面的回车有的 TUI 会当成粘贴里的换行）。屏幕上有那些字时等下一次安静。
// 一直等不到安静（启动画面一直在动）时，readyMaxMs 之后照样看一次屏幕再打。终端退出了就不打。
// 打字用 TerminalHost.sendText（contracts 0.1.22，send-keys -l 按原文）；没有时退回 sendKeys + literalKeys。控制字符都先换成空格。

import type { TerminalEvent, TerminalHost, TerminalId } from '@agentdeck/contracts';

export interface FirstMessageTiming {
  /** 打完字到按回车之间停多久（毫秒），默认 500。 */
  typeDelayMs?: number;
  /** 最多等多久的第一次安静（毫秒），默认 20000；之后照样打（屏幕上有 notReadyScreens 的字时仍然等）。 */
  readyMaxMs?: number;
}

interface Pending {
  text: string;
  notReady: readonly string[];
  timer: ReturnType<typeof setTimeout> | null;
  busy: boolean;
}

export class FirstMessageTyper {
  private readonly pending = new Map<TerminalId, Pending>();
  private readonly typeDelayMs: number;
  private readonly readyMaxMs: number;

  constructor(
    private readonly terminals: Pick<TerminalHost, 'sendKeys'> & Partial<Pick<TerminalHost, 'lastLines' | 'sendText'>>,
    timing: FirstMessageTiming = {},
    /** 打出去之后（测试、日志用）。 */
    private readonly onTyped?: (terminalId: TerminalId) => void,
  ) {
    this.typeDelayMs = timing.typeDelayMs ?? 500;
    this.readyMaxMs = timing.readyMaxMs ?? 20_000;
  }

  /** 终端开起来之后登记。 */
  add(terminalId: TerminalId, text: string, notReady: readonly string[] = []): void {
    const p: Pending = { text, notReady, timer: null, busy: false };
    p.timer = setTimeout(() => void this.tryType(terminalId), this.readyMaxMs);
    p.timer.unref?.();
    this.pending.set(terminalId, p);
  }

  has(terminalId: TerminalId): boolean {
    return this.pending.has(terminalId);
  }

  onTerminalEvent(event: TerminalEvent): void {
    switch (event.type) {
      case 'terminal.silence':
        if (this.pending.has(event.id)) void this.tryType(event.id);
        return;
      case 'terminal.exit':
        this.drop(event.id);
        return;
      case 'terminal.host-lost':
        for (const id of [...this.pending.keys()]) this.drop(id);
        return;
      default:
        return;
    }
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.drop(id);
  }

  private drop(id: TerminalId): void {
    const p = this.pending.get(id);
    if (p?.timer) clearTimeout(p.timer);
    this.pending.delete(id);
  }

  private async tryType(id: TerminalId): Promise<void> {
    const p = this.pending.get(id);
    if (!p || p.busy) return;
    p.busy = true;
    try {
      if (p.notReady.length > 0 && this.terminals.lastLines) {
        const screen = (await this.terminals.lastLines(id, 60).catch(() => [] as string[])).join('\n');
        if (p.notReady.some((s) => screen.includes(s))) return; // 等下一次安静
      }
      if (this.pending.get(id) !== p) return;
      this.drop(id);
      if (this.terminals.sendText) {
        const text = plainText(p.text);
        if (text) await this.terminals.sendText(id, text);
      } else {
        await this.terminals.sendKeys(id, literalKeys(p.text));
      }
      await new Promise((r) => setTimeout(r, this.typeDelayMs));
      await this.terminals.sendKeys(id, ['Enter']);
      this.onTyped?.(id);
    } catch {
      // 终端没了；没法再打
    } finally {
      p.busy = false;
    }
  }
}

/** 控制字符（换行、制表符……）换成空格：不会被执行，也不会提前提交。 */
export function plainText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

/**
 * 没有 sendText 时（老的 TerminalHost）：把一段文字变成 TerminalHost.sendKeys 的参数，让 tmux 当成普通字符打出去（tmux-host 的 sendKeys 不带 -l）：
 * - 控制字符（换行、制表符……）换成空格，不会被执行，也不会提前提交；
 * - tmux 把以 ; 结尾的参数当成命令分隔符，结尾的 ; 写成 \;（tmux 会还原成 ;）；
 * - 没有空格的一段可能正好是按键名（Enter、Up、C-c、F1……），这种拆成一个字一个参数（单个字符就是它自己）。
 * 有空格的整段不会是按键名，tmux 认不出就按字符原样发送。
 */
export function literalKeys(text: string): string[] {
  const clean = plainText(text);
  if (clean.length === 0) return [];
  const parts = /\s/.test(clean) ? [clean] : [...clean];
  return parts.map((s) => (s.endsWith(';') ? `${s.slice(0, -1)}\\;` : s));
}
