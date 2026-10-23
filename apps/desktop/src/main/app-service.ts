// AppService 的真实实现（contracts app.ts）：系统对话框、外部程序、设置、退出、角标。
// Electron 的东西从参数传进来；拼命令的纯函数单独导出，方便单测。

import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AgentDeckError, type AbsPath, type AppService, type Settings, type TerminalId } from '@agentdeck/contracts';
import { findExecutable, splitCommand } from '@agentdeck/agent-adapters';
import type { Env } from './login-env.ts';
import type { SettingsFile } from './settings.ts';

/** 认 “文件:行号” 写法的编辑器（code -g、cursor -g、subl、zed）。 */
export function editorArgs(command: string, path: string, line?: number): { cmd: string; args: string[] } | null {
  const parts = splitCommand(command);
  const cmd = parts[0];
  if (!cmd) return null;
  const rest = parts.slice(1);
  const goto = rest.includes('-g') || rest.includes('--goto') || ['subl', 'zed'].includes(basename(cmd));
  const target = line !== undefined && line > 0 && goto ? `${path}:${line}` : path;
  return { cmd, args: [...rest, target] };
}

/** AppleScript 字符串字面量。 */
export function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Open in system terminal：Terminal、iTerm 用 AppleScript；别的 App 打开一个 .command 文件。 */
export function systemTerminalPlan(app: string, command: string): { kind: 'osascript'; script: string } | { kind: 'command-file' } {
  const name = app.trim() || 'Terminal';
  if (/^terminal(\.app)?$/i.test(name)) {
    return { kind: 'osascript', script: `tell application "Terminal"\nactivate\ndo script ${appleScriptString(command)}\nend tell` };
  }
  if (/^iterm2?(\.app)?$/i.test(name)) {
    return {
      kind: 'osascript',
      script: `tell application "iTerm"\nactivate\ncreate window with default profile command ${appleScriptString(command)}\nend tell`,
    };
  }
  return { kind: 'command-file' };
}

export interface AppServiceDeps {
  homeDir: AbsPath;
  env: () => Env;
  settings: SettingsFile;
  /** 设置改了之后（推 app.settings 事件）。 */
  onSettingsChanged(settings: Settings): void;
  /** 放 .command 文件的目录。 */
  runDir: string;
  attachCommand(id: TerminalId): Promise<string>;
  pickFolder(opts: { title: string; defaultPath?: string }): Promise<string | null>;
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
  trashItem(path: string): Promise<void>;
  quit(stopTerminals: boolean): Promise<void>;
  setBadge(count: number): void;
}

function run(cmd: string, args: string[], env: Env, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function createAppService(deps: AppServiceDeps): AppService {
  return {
    homeDir: async () => deps.homeDir,
    pickFolder: async (opts) => (await deps.pickFolder(opts)) as AbsPath | null,

    async openInEditor(path, line) {
      const env = deps.env();
      const plan = editorArgs(deps.settings.get().editorCommand, path, line);
      const exe = plan ? await findExecutable(plan.cmd, env) : null;
      if (!plan || !exe) {
        // 编辑器命令找不到：交给系统的默认程序打开
        const err = await deps.openPath(path);
        if (err) throw new AgentDeckError({ code: 'command-not-found', message: `Couldn’t open ${basename(path)}`, detail: err });
        return;
      }
      await run(exe, plan.args, env, dirname(path));
    },

    async openInSystemTerminal(id) {
      const command = await deps.attachCommand(id);
      const app = deps.settings.get().terminalApp;
      const plan = systemTerminalPlan(app, command);
      const env = deps.env();
      if (plan.kind === 'osascript') {
        await run('/usr/bin/osascript', ['-e', plan.script], env);
        return;
      }
      await mkdir(deps.runDir, { recursive: true });
      const file = join(deps.runDir, `attach-${id}.command`);
      await writeFile(file, `#!/bin/sh\nexec ${command}\n`);
      await chmod(file, 0o755);
      await run('/usr/bin/open', ['-a', app, file], env);
    },

    revealInFinder: async (path) => deps.showItemInFolder(path),
    moveToTrash: (path) => deps.trashItem(path),
    getSettings: async () => deps.settings.get(),
    async updateSettings(patch) {
      const next = deps.settings.update(patch);
      deps.onSettingsChanged(next);
      return next;
    },
    quit: (req) => deps.quit(req.stopTerminals),
    setBadge: (count) => deps.setBadge(count),
  };
}
