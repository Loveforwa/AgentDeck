// 启动、退出真 AgentDeck（apps/desktop/out，先跑 scripts/build-app.mjs）。
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { DESKTOP_DIR, type Sandbox } from './sandbox.ts';

const electronPath = createRequire(join(DESKTOP_DIR, 'package.json'))('electron') as string;

export interface RunningApp {
  app: ElectronApplication;
  page: Page;
  /** 主进程的 stdout / stderr（[agentdeck] 日志、界面 console），出错时附进报告。 */
  logs: string[];
}

/** 启动选项（都可以不给，默认和以前一样）。 */
export interface LaunchOptions {
  /** 额外的 Chromium / Electron 命令行参数（例如 TC-27 的 --host-resolver-rules）。 */
  args?: string[];
  /** false：不等白板画出来（TC-19 的 tmux 说明页没有白板）。默认 true。 */
  waitForBoard?: boolean;
}

export async function launchApp(sb: Sandbox, opts: LaunchOptions = {}): Promise<RunningApp> {
  const app = await _electron.launch({
    executablePath: electronPath,
    // --user-data-dir：Electron 的 userData 和单实例锁都放进沙盒，用户自己开着 AgentDeck 时也能起来
    args: [DESKTOP_DIR, `--user-data-dir=${sb.userDataDir}`, ...(opts.args ?? [])],
    cwd: DESKTOP_DIR,
    env: sb.env,
    timeout: 60_000,
  });
  const logs: string[] = [];
  const proc = app.process();
  proc.stdout?.on('data', (c: Buffer) => logs.push(c.toString('utf8')));
  proc.stderr?.on('data', (c: Buffer) => logs.push(c.toString('utf8')));
  const page = await app.firstWindow({ timeout: 60_000 });
  // Playwright 接管时第一个页面的 preload 会跑两次（只在 Playwright 下见到），主进程开了两条终端输出端口：
  // preload 拿到第一条，utilityProcess 用的是第二条，终端就收不到输出、输入也一直扣着（见 e2e/AGENTS.md「已知问题」）。
  // 刷新一次页面后只有一条端口，和正常启动一样。
  await page.waitForLoadState('domcontentloaded');
  await page.reload();
  // 白板控制器挂上（dev 构建才有）、白板从库里读完
  await page.waitForFunction(() => Boolean((window as unknown as { __board?: unknown }).__board), null, { timeout: 60_000 });
  if (opts.waitForBoard !== false) await page.locator('.react-flow').first().waitFor({ timeout: 60_000 });
  return { app, page, logs };
}

/**
 * 和 ⌘Q 一样退出：点应用菜单里的 Quit（Playwright 的按键只到页面，到不了系统菜单的 accelerator）。
 * 会话留在 tmux 里。等主进程真的退出。
 */
export async function quitApp(running: RunningApp): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    const proc = running.app.process();
    if (proc.exitCode !== null) resolve();
    else proc.once('exit', () => resolve());
  });
  await running.app
    .evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
        for (const item of items) {
          if (item.role === 'quit' || item.accelerator === 'CmdOrCtrl+Q' || item.accelerator === 'Command+Q') return item;
          const sub = item.submenu ? find(item.submenu.items) : null;
          if (sub) return sub;
        }
        return null;
      };
      const quit = find(Menu.getApplicationMenu()?.items ?? []);
      if (!quit) throw new Error('no Quit item in the application menu');
      // click 的签名是 (menuItem, window, event)，菜单项自己的回调不看参数
      quit.click();
    })
    .catch(() => undefined); // 进程退出时 evaluate 可能来不及返回
  await exited;
}

/** 测试结束时：还在跑就直接关（不等存白板）。 */
export async function closeApp(running: RunningApp | null): Promise<void> {
  if (!running) return;
  const proc = running.app.process();
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await running.app.close().catch(() => undefined);
}
