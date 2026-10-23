// AppService 的假实现：系统对话框和外部程序都只记一笔，设置存在内存里。

import type { AbsPath, AppService, QuitRequest, Settings, TerminalId } from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';
import { clone } from './util.ts';

export const DEFAULT_SETTINGS: Settings = {
  closeWindow: 'background',
  notifications: true,
  editorCommand: 'code -g',
  terminalApp: 'Terminal',
  defaultAgent: 'claude',
  agents: {
    claude: { extraArgs: [], waitingText: null },
    codex: { extraArgs: [], waitingText: null },
    gemini: { extraArgs: [], waitingText: null },
  },
  approvals: {
    destructivePatterns: [
      '\\brm\\s+-[a-zA-Z]*[rf]',
      '\\bgit\\s+push\\b.*(--force|-f\\b)',
      '\\bgit\\s+reset\\s+--hard\\b',
      '\\bgit\\s+clean\\b',
      '\\bdrop\\s+(table|database)\\b',
      '\\bsudo\\b',
    ],
  },
};

export interface FakeAppCall {
  method: 'openInEditor' | 'openInSystemTerminal' | 'revealInFinder' | 'moveToTrash';
  args: unknown[];
}

export interface FakeAppServiceOptions {
  bus?: FakeEventBus;
  settings?: Settings;
  /** pickFolder 没有排队答案时返回什么。默认 null（相当于取消）。 */
  defaultPick?: AbsPath | null;
}

export class FakeAppService implements AppService {
  readonly bus: FakeEventBus;
  /** 打开编辑器、Finder、废纸篓等调用记录。 */
  readonly calls: FakeAppCall[] = [];
  readonly trashed: AbsPath[] = [];
  badge = 0;
  quitRequest: QuitRequest | null = null;
  defaultPick: AbsPath | null;
  private settings: Settings;
  private readonly picks: (AbsPath | null)[] = [];

  constructor(opts: FakeAppServiceOptions = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
    this.settings = clone(opts.settings ?? DEFAULT_SETTINGS);
    this.defaultPick = opts.defaultPick ?? null;
  }

  /** 让接下来几次 pickFolder 依次返回这些值（null 表示取消）。 */
  queuePickFolder(...answers: (AbsPath | null)[]): void {
    this.picks.push(...answers);
  }

  async pickFolder(_opts: { title: string; defaultPath?: AbsPath }): Promise<AbsPath | null> {
    return this.picks.length > 0 ? (this.picks.shift() ?? null) : this.defaultPick;
  }

  async openInEditor(path: AbsPath, line?: number): Promise<void> {
    this.calls.push({ method: 'openInEditor', args: line === undefined ? [path] : [path, line] });
  }

  async openInSystemTerminal(id: TerminalId): Promise<void> {
    this.calls.push({ method: 'openInSystemTerminal', args: [id] });
  }

  async revealInFinder(path: AbsPath): Promise<void> {
    this.calls.push({ method: 'revealInFinder', args: [path] });
  }

  async moveToTrash(path: AbsPath): Promise<void> {
    this.calls.push({ method: 'moveToTrash', args: [path] });
    this.trashed.push(path);
  }

  async getSettings(): Promise<Settings> {
    return clone(this.settings);
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    this.settings = { ...this.settings, ...clone(patch) };
    this.bus.emit({ type: 'app.settings', settings: clone(this.settings) });
    return clone(this.settings);
  }

  async quit(req: QuitRequest): Promise<void> {
    this.quitRequest = { ...req };
  }

  setBadge(count: number): void {
    this.badge = count;
  }

  /** 同步读当前设置（不拷贝，别改）。给其他假服务用。 */
  current(): Readonly<Settings> {
    return this.settings;
  }

  windowShown(): void {
    this.bus.emit({ type: 'app.window-shown' });
  }

  /** 模拟单击系统通知。 */
  focusTerminal(terminalId: TerminalId): void {
    this.bus.emit({ type: 'app.focus-terminal', terminalId });
  }
}
