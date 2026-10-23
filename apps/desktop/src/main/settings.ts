// 设置存在数据目录的 settings.json（store 里还没有 settings 表，见 packages/store/CONTRACT_NOTES.md 第 1 条）。
// 读不到或格式不对时用默认值；写入先写临时文件再改名，不会写出半个文件。纯 node，不 import Electron。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export function openSettingsFile(path: string, defaults: Settings): SettingsFile {
  let current = defaults;
  try {
    current = mergeSettings(defaults, JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // 没有文件或坏了：用默认值，第一次改设置时写出来
  }
  return {
    path,
    get: () => current,
    update(patch) {
      current = mergeSettings(current, { ...current, ...patch });
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`);
      renameSync(tmp, path);
      return current;
    },
  };
}
