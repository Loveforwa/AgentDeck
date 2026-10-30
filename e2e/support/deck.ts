// 测试里操作 AgentDeck 的小工具：读白板状态、找空白处、等终端输出、等状态、截图。
// 用户动作尽量走真的输入（右键、点击、键盘、拖动）；准备场景和断言可以用 window.__board（白板控制器）和 window.agentdeck（API）。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { closeApp, launchApp, quitApp, type LaunchOptions, type RunningApp } from './app.ts';
import type { Sandbox } from './sandbox.ts';

/** 白板状态里测试关心的部分（能序列化的）。 */
export interface BoardSnapshot {
  loaded: boolean;
  focusedId: string | null;
  selectedFrame: string | null;
  viewport: { x: number; y: number; zoom: number };
  frames: { workspaceId: string; rect: Rect }[];
  windows: { id: string; type: string; workspaceId: string | null; rect: Rect; restoreRect: Rect | null; title: string | null; data: Record<string, unknown> }[];
  workspaces: Record<string, { id: string; projectId: string; name: string; path: string; branch: string | null; mode: string }>;
  projects: { id: string; name: string; kind: string; path: string; repos: { name: string; path: string; baseBranch: string }[]; setupCommand: string | null }[];
  statuses: Record<string, { terminalId: string; status: string; agent: string; pending?: unknown }>;
  /** MP1：左边管理面板的置顶。 */
  pins: { kind: string }[];
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Deck {
  private running: RunningApp | null = null;
  private shots = 0;

  constructor(
    readonly sb: Sandbox,
    private readonly info: TestInfo,
  ) {}

  get app(): ElectronApplication {
    if (!this.running) throw new Error('AgentDeck is not running');
    return this.running.app;
  }

  get page(): Page {
    if (!this.running) throw new Error('AgentDeck is not running');
    return this.running.page;
  }

  async launch(opts: LaunchOptions = {}): Promise<Page> {
    this.running = await launchApp(this.sb, opts);
    await this.guardMainProcess();
    return this.running.page;
  }

  /** ⌘Q（应用菜单的 Quit）：会话留在 tmux 里。 */
  async quit(): Promise<void> {
    if (!this.running) return;
    await quitApp(this.running);
    this.attachLogs('main-process-log');
    this.running = null;
  }

  /**
   * 主进程里换掉会碰到沙盒外面的东西：
   * - 系统的选文件夹窗口（Playwright 点不到原生对话框）：由 pickFolder() 预先给答案；
   * - 废纸篓：git-service 放弃未跟踪文件时会移到废纸篓，这里改成只删沙盒里的路径，不往用户的废纸篓里放东西；
   * - 打开系统浏览器、编辑器：什么也不做。
   */
  private async guardMainProcess(): Promise<void> {
    await this.app.evaluate(({ dialog, shell }, root) => {
      const g = globalThis as unknown as { __e2eFolder?: string | null };
      g.__e2eFolder = null;
      dialog.showOpenDialog = (async () => {
        const folder = g.__e2eFolder ?? null;
        return folder ? { canceled: false, filePaths: [folder] } : { canceled: true, filePaths: [] };
      }) as typeof dialog.showOpenDialog;
      shell.trashItem = async (p: string) => {
        if (!p.startsWith(root)) throw new Error(`e2e: refusing to trash ${p} outside the sandbox`);
        const { rmSync } = process.getBuiltinModule('node:fs');
        rmSync(p, { recursive: true, force: true });
      };
      shell.openExternal = async () => {};
      shell.openPath = async () => '';
      shell.showItemInFolder = () => {};
    }, this.sb.root);
  }

  /** 下一次“选文件夹”窗口直接选这个文件夹。 */
  async pickFolder(folder: string): Promise<void> {
    await this.app.evaluate((_e, f) => {
      (globalThis as unknown as { __e2eFolder?: string | null }).__e2eFolder = f;
    }, folder);
  }

  async board(): Promise<BoardSnapshot> {
    return this.page.evaluate(() => {
      const s = (window as unknown as { __board: { state: Record<string, unknown> } }).__board.state;
      const pick = {
        loaded: s['loaded'],
        focusedId: s['focusedId'],
        selectedFrame: s['selectedFrame'],
        viewport: s['viewport'],
        frames: s['frames'],
        windows: s['windows'],
        workspaces: s['workspaces'],
        projects: s['projects'],
        statuses: s['statuses'],
        pins: s['pins'],
      };
      return JSON.parse(JSON.stringify(pick)) as BoardSnapshot;
    });
  }

  /** 白板空白处的一个点（屏幕坐标）：不在任何框、窗口、面板、顶栏上。 */
  async emptyPoint(prefer: 'left' | 'right' | 'bottom' = 'left'): Promise<{ x: number; y: number }> {
    const p = await this.page.evaluate((prefer) => {
      const pane = document.querySelector('.react-flow__pane');
      if (!pane) return null;
      const r = pane.getBoundingClientRect();
      const xs: number[] = [];
      const ys: number[] = [];
      for (let x = r.left + 60; x < r.right - 60; x += 40) xs.push(x);
      for (let y = r.top + 80; y < r.bottom - 60; y += 40) ys.push(y);
      if (prefer === 'right') xs.reverse();
      if (prefer === 'bottom') ys.reverse();
      const order = prefer === 'bottom' ? ys.flatMap((y) => xs.map((x) => [x, y] as const)) : xs.flatMap((x) => ys.map((y) => [x, y] as const));
      for (const [x, y] of order) {
        // 四周留点余量，菜单、新框不会压到别的东西
        const ok = [
          [0, 0],
          [30, 0],
          [-30, 0],
          [0, 30],
          [0, -30],
        ].every(([dx, dy]) => document.elementFromPoint(x + dx!, y + dy!) === pane);
        if (ok) return { x: Math.round(x), y: Math.round(y) };
      }
      return null;
    }, prefer);
    if (!p) throw new Error('no empty spot on the board');
    return p;
  }

  /** 屏幕上某个窗口（data-window-id）。 */
  windowEl(windowId: string): Locator {
    return this.page.locator(`.ad-window-node[data-window-id="${windowId}"]`);
  }

  /** 工作区框：按标题里的分支名找。 */
  frameEl(branch: string): Locator {
    return this.page.locator('.ad-frame', { has: this.page.locator('.ad-frame-branch', { hasText: new RegExp(`^${escapeRe(branch)}$`) }) });
  }

  /** 打开右键菜单里的一项（可以带子菜单：['New terminal', 'Shell']）。 */
  async pickMenu(path: string[]): Promise<void> {
    const menu = this.page.getByRole('menu').first();
    await menu.waitFor();
    for (const [i, label] of path.entries()) {
      // 可读名称后面可能带快捷键（“New workspace… ⌘⇧N”）
      const item = this.page.getByRole('menuitem', { name: new RegExp(`^${escapeRe(label)}( |$)`) }).last();
      if (i < path.length - 1) {
        await item.hover();
        await item.click();
      } else {
        await item.click();
      }
    }
  }

  /** 终端窗口的 terminalId。 */
  async terminalIdOf(windowId: string): Promise<string> {
    const b = await this.board();
    const w = b.windows.find((x) => x.id === windowId);
    const id = w?.data['terminalId'];
    if (typeof id !== 'string') throw new Error(`window ${windowId} has no terminal`);
    return id;
  }

  /** 等白板上出现满足条件的新窗口，返回它的 id。 */
  async waitForWindow(pred: (w: BoardSnapshot['windows'][number]) => boolean, known: string[] = []): Promise<string> {
    let found: string | null = null;
    await expect
      .poll(
        async () => {
          const b = await this.board();
          found = b.windows.find((w) => !known.includes(w.id) && pred(w))?.id ?? null;
          return found;
        },
        { timeout: 30_000, message: 'waiting for a new window on the board' },
      )
      .not.toBeNull();
    return found!;
  }

  /** 假 claude 的日志（发了哪些钩子、收到哪些按键），按终端 id 找。 */
  agentLog(terminalId: string): { kind: string; event?: string; how?: string; wired?: boolean; terminal: string | null; line?: string }[] {
    if (!existsSync(this.sb.agentLogDir)) return [];
    return readdirSync(this.sb.agentLogDir)
      .flatMap((f) => readFileSync(join(this.sb.agentLogDir, f), 'utf8').split('\n'))
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ReturnType<Deck['agentLog']>[number])
      .filter((e) => e.terminal === terminalId);
  }

  /** tmux 窗格里现在的画面（后台：tmux capture-pane）。 */
  pane(terminalId: string): string {
    return this.sb.tmux(['capture-pane', '-p', '-J', '-t', `=${terminalId}:`]).stdout;
  }

  async waitForPane(terminalId: string, re: RegExp, timeout = 30_000): Promise<string> {
    let text = '';
    await expect
      .poll(
        () => {
          text = this.pane(terminalId);
          return re.test(text);
        },
        { timeout, message: `terminal ${terminalId} to show ${re}` },
      )
      .toBe(true);
    return text;
  }

  /** 状态机给这个终端的状态（status.changed 之后白板里存的那份）。 */
  async status(terminalId: string): Promise<string | null> {
    return this.page.evaluate((id) => {
      const s = (window as unknown as { __board: { state: { statuses: Record<string, { status: string }> } } }).__board.state;
      return s.statuses[id]?.status ?? null;
    }, terminalId);
  }

  async waitForStatus(terminalId: string, status: string | RegExp, timeout = 30_000): Promise<void> {
    const re = typeof status === 'string' ? new RegExp(`^${status}$`) : status;
    await expect.poll(async () => (await this.status(terminalId)) ?? '', { timeout, message: `terminal ${terminalId} status` }).toMatch(re);
  }

  /** ⌘1 Show all：所有框和窗口放进视口（真的按键），等视口动画停下。 */
  async showAll(): Promise<void> {
    await this.page.keyboard.press('Meta+1');
    let last = '';
    await expect
      .poll(async () => {
        const v = JSON.stringify((await this.board()).viewport);
        const same = v === last;
        last = v;
        return same;
      }, { intervals: [250] })
      .toBe(true);
  }

  /** 单击窗口内容让它聚焦（第一下只聚焦），之后键盘输入进这个终端。 */
  async focusWindow(windowId: string): Promise<void> {
    const content = this.windowEl(windowId).locator('.ad-window-content');
    // 按下和抬起之间留 80ms，像真人点击。没有间隔时（Playwright 默认）按下聚焦、窗口重排之后 click 落到白板空白处，
    // 又把焦点清掉了（见 e2e/AGENTS.md「已知问题」）
    await content.click({ position: { x: 60, y: 40 }, delay: 80 });
    await expect.poll(async () => (await this.board()).focusedId).toBe(windowId);
  }

  /** 在聚焦的终端里打一行字（真的键盘输入，经 xterm → tmux）。 */
  async typeLine(text: string): Promise<void> {
    await this.page.keyboard.type(text, { delay: 15 });
    await this.page.keyboard.press('Enter');
  }

  /**
   * 在终端画面上单击一段文字（真的鼠标：先悬停让 xterm 认出链接，再单击）。
   * xterm 用 WebGL 画，DOM 里没有文字：位置从 tmux 的画面（capture-pane，和 xterm 一行对一行）和格子大小算出来。
   */
  async clickTerminalText(windowId: string, terminalId: string, text: string): Promise<void> {
    const lines = this.sb.tmux(['capture-pane', '-p', '-t', `=${terminalId}:`]).stdout.split('\n');
    const row = lines.findIndex((l) => l.includes(text));
    if (row < 0) throw new Error(`"${text}" is not on the screen of ${terminalId}`);
    const col = lines[row]!.indexOf(text);
    const [cols, rows] = this.sb
      .tmux(['display-message', '-p', '-t', `=${terminalId}:`, '#{pane_width} #{pane_height}'])
      .stdout.trim()
      .split(' ')
      .map(Number) as [number, number];
    const screen = this.windowEl(windowId).locator('.xterm-screen');
    const box = await screen.boundingBox();
    if (!box) throw new Error('terminal screen not visible');
    const cellW = box.width / cols;
    const cellH = box.height / rows;
    const x = box.x + (col + Math.min(4, text.length / 2)) * cellW + cellW / 2;
    const y = box.y + row * cellH + cellH / 2;
    await this.page.mouse.move(x - 2 * cellW, y);
    await this.page.mouse.move(x, y, { steps: 3 });
    // xterm 认出链接后鼠标变成手形
    await expect(screen).toHaveClass(/xterm-cursor-pointer/);
    await this.page.mouse.down();
    await this.page.waitForTimeout(60);
    await this.page.mouse.up();
  }

  /** 截图存进这个测试的输出目录，并附到报告里。 */
  async screenshot(name: string): Promise<string> {
    const file = this.info.outputPath(`${String(++this.shots).padStart(2, '0')}-${name}.png`);
    await this.page.screenshot({ path: file });
    await this.info.attach(name, { path: file, contentType: 'image/png' });
    return file;
  }

  private attachLogs(name: string): void {
    const text = this.running?.logs.join('') ?? '';
    if (text) void this.info.attach(name, { body: text, contentType: 'text/plain' });
  }

  /** 测试结束：截最后一张图，附上主进程日志，关掉应用。 */
  async finish(): Promise<void> {
    if (this.running) {
      await this.screenshot('final').catch(() => undefined);
      this.attachLogs('main-process-log');
    }
    await closeApp(this.running);
    this.running = null;
  }
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
