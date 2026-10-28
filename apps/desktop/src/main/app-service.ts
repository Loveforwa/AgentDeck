// AppService 的真实实现（contracts app.ts）：系统对话框、外部程序、设置、退出、角标。
// Electron 的东西从参数传进来；拼命令的纯函数单独导出，方便单测。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

/** 编辑器的命令行工具在 App 包里的位置：没在 PATH 里装 code / cursor / zed / subl 的人（很常见）也能用。 */
const BUNDLED_EDITOR_CLI: Record<string, string[]> = {
  code: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
  cursor: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor'],
  zed: ['/Applications/Zed.app/Contents/MacOS/cli'],
  subl: ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'],
};

/** 编辑器命令 → 可执行文件：先找 PATH，再找 App 包（也找 ~/Applications）。都没有返回 null。 */
export async function resolveEditor(cmd: string, env: Env, exists: (path: string) => boolean = existsSync): Promise<string | null> {
  const found = await findExecutable(cmd, env);
  if (found) return found;
  const home = env['HOME'];
  for (const path of BUNDLED_EDITOR_CLI[basename(cmd)] ?? []) {
    for (const candidate of home ? [path, join(home, path)] : [path]) if (exists(candidate)) return candidate;
  }
  return null;
}

export type OpenFileResult = { opened: 'editor' } | { opened: 'finder'; message: string };

/**
 * Settings 打开 settings.json（IS-47）：用设置里的编辑器（editorCommand，默认 code -g）打开；编辑器找不到或起不来时
 * 在 Finder 里显示这个文件，返回给界面要显示的提示。不交给系统的默认程序：.json 的默认程序可能是任何东西
 * （2026-10-24 用户机器上是 Tor Browser），而且失败时什么都看不到。
 */
export async function openFileInEditor(
  path: string,
  deps: { editorCommand: string; env: Env; showItemInFolder(path: string): void; run?: typeof run; exists?: (path: string) => boolean },
): Promise<OpenFileResult> {
  const plan = editorArgs(deps.editorCommand, path);
  const exe = plan ? await resolveEditor(plan.cmd, deps.env, deps.exists) : null;
  if (plan && exe) {
    try {
      await (deps.run ?? run)(exe, plan.args, deps.env, dirname(path));
      return { opened: 'editor' };
    } catch {
      // 起不来：和找不到一样，退回 Finder
    }
  }
  deps.showItemInFolder(path);
  const editor = deps.editorCommand.trim();
  const why = editor === '' ? 'No editor command is set' : `Couldn’t open it with “${editor}”`;
  return { opened: 'finder', message: `${why}, so ${basename(path)} is shown in Finder instead. Set editorCommand in it to your editor (for example code -g).` };
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

export function run(cmd: string, args: string[], env: Env, cwd?: string): Promise<void> {
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
      const exe = plan ? await resolveEditor(plan.cmd, env) : null;
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
    // PL3 的实现还没合进来，先占位：调用方收到 unsupported
    setKeepAwake: async () => {
      throw new AgentDeckError({ code: 'unsupported', message: 'Keep Mac awake isn’t available yet' });
    },
  };
}
