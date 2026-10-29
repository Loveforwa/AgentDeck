// 设置存在数据目录的 settings.json（store 里还没有 settings 表，见 packages/store/CONTRACT_NOTES.md 第 1 条）。
// 读不到或格式不对时用默认值；写入先写临时文件再改名，不会写出半个文件。纯 node，不 import Electron。

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Settings } from '@agentdeck/contracts';

export function defaultSettings(destructivePatterns: readonly string[]): Settings {
  return {
    closeWindow: 'background',
    notifications: true,
    editorCommand: 'code -g',
    terminalApp: 'Terminal',
    defaultAgent: 'claude',
    agents: {},
    approvals: { destructivePatterns: [...destructivePatterns] },
  };
}

/** 文件里的值盖在默认值上；类型不对的字段丢掉。 */
export function mergeSettings(base: Settings, raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const out: Settings = { ...base, approvals: { ...base.approvals }, agents: { ...base.agents } };
  if (r['closeWindow'] === 'background' || r['closeWindow'] === 'quit') out.closeWindow = r['closeWindow'];
  if (typeof r['notifications'] === 'boolean') out.notifications = r['notifications'];
  if (typeof r['editorCommand'] === 'string') out.editorCommand = r['editorCommand'];
  if (typeof r['terminalApp'] === 'string') out.terminalApp = r['terminalApp'];
  if (typeof r['defaultAgent'] === 'string') out.defaultAgent = r['defaultAgent'];
  // PL5 / PL6：Settings › Resume prompt（续跑的模板，空的用内置的那段）。之前没在这里认，存进去也读不出来
  if (typeof r['resumePrompt'] === 'string') out.resumePrompt = r['resumePrompt'];
  if (typeof r['agents'] === 'object' && r['agents'] !== null) out.agents = r['agents'] as Settings['agents'];
  const approvals = r['approvals'] as { destructivePatterns?: unknown } | undefined;
  if (approvals && Array.isArray(approvals.destructivePatterns)) {
    out.approvals = { destructivePatterns: approvals.destructivePatterns.filter((p): p is string => typeof p === 'string') };
  }
  return out;
}

export interface SettingsFile {
  get(): Settings;
  update(patch: Partial<Settings>): Settings;
  readonly path: string;
}

/**
 * 用户可以在编辑器里直接改 settings.json（Settings 打开的就是它）：每次 get() 先看文件的修改时间，变了就重新读，
 * 手改的内容马上生效，之后 update() 也是在手改的基础上改，不会把它盖掉。改坏了（JSON 不合法）就继续用上一次的值。
 */
export function openSettingsFile(path: string, defaults: Settings): SettingsFile {
  let current = defaults;
  let seen: number | null = null;
  const reload = () => {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return; // 没有文件：用默认值，第一次改设置时写出来
    }
    if (mtime === seen) return;
    seen = mtime;
    try {
      current = mergeSettings(defaults, JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      // 坏了：保留上一次读到的
    }
  };
  reload();
  return {
    path,
    get: () => {
      reload();
      return current;
    },
    update(patch) {
      reload();
      current = mergeSettings(current, { ...current, ...patch });
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`);
      renameSync(tmp, path);
      seen = statSync(path).mtimeMs;
      return current;
    },
  };
}
