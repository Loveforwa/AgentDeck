// 截图模式（AGENTDECK_SCREENSHOT=<png 路径>）：白板加载完、看得见的终端都接上并有输出之后，
// 再等一会儿（agent 画完启动画面、面板拿到 git 状态），把整个窗口存成 PNG，然后正常退出（不结束 tmux 里的终端）。
// 不 import Electron：截图和退出从参数传进来。

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BoardReadyInfo } from '../shared/desktop-bridge.ts';

export interface ScreenshotterDeps {
  path: string;
  capture(): Promise<Buffer>;
  done(ok: boolean): void;
  log?(message: string): void;
  /** 都有输出之后再等多久，默认 AGENTDECK_SCREENSHOT_DELAY 或 6000ms。 */
  settleMs?: number;
  /** 白板好了之后最多等终端多久，默认 30 秒；到时有多少截多少。 */
  terminalWaitMs?: number;
  /** 整个过程最多多久，默认 90 秒，超时失败退出。 */
  overallMs?: number;
}

export interface Screenshotter {
  start(): void;
  boardReady(info: BoardReadyInfo): void;
  terminalData(viewId: string): void;
}

export function createScreenshotter(deps: ScreenshotterDeps): Screenshotter {
  const log = deps.log ?? (() => {});
  const settleMs = deps.settleMs ?? (Number(process.env['AGENTDECK_SCREENSHOT_DELAY']) || 6000);
  const seen = new Set<string>();
  let expected: number | null = null;
  let phase: 'waiting' | 'settling' | 'done' = 'waiting';
  let waitTimer: ReturnType<typeof setTimeout> | null = null;

  const shoot = async () => {
    if (phase === 'done') return;
    phase = 'done';
    try {
      const png = await deps.capture();
      await mkdir(dirname(deps.path), { recursive: true });
      await writeFile(deps.path, png);
      log(`saved ${deps.path} (${png.length} bytes)`);
      deps.done(true);
    } catch (e) {
      log(`failed: ${e instanceof Error ? e.message : String(e)}`);
      deps.done(false);
    }
  };

  const settle = (why: string) => {
    if (phase !== 'waiting') return;
    phase = 'settling';
    if (waitTimer) clearTimeout(waitTimer);
    log(`${why}; capturing in ${settleMs}ms`);
    setTimeout(() => void shoot(), settleMs);
  };

  const check = () => {
    if (expected === null || phase !== 'waiting') return;
    if (seen.size >= expected) settle(`board ready, ${seen.size}/${expected} terminals have output`);
  };

  return {
    start() {
      setTimeout(() => {
        if (phase === 'done') return;
        log('timed out');
        phase = 'done';
        deps.done(false);
      }, deps.overallMs ?? 90_000).unref?.();
    },
    boardReady(info) {
      if (expected !== null) return;
      expected = info.visibleTerminals;
      log(`board ready, waiting for ${expected} terminal(s)`);
      waitTimer = setTimeout(() => settle(`only ${seen.size}/${expected ?? 0} terminals have output`), deps.terminalWaitMs ?? 30_000);
      check();
    },
    terminalData(viewId) {
      seen.add(viewId);
      check();
    },
  };
}
