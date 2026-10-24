// AgentDeck 的 skill 库和 MCP 库（N9），都在 AgentDeck 的数据目录下（docs/decisions.md：~/.agentdeck，开发时 .agentdeck-dev）：
//   <skillsDir>/<name>/SKILL.md          Add skill… 复制进来的文件夹
//   <mcpDir>/<name>.json                 Add MCP… 登记的服务：{ "command": "npx", "args": [...] } 或 { "url": "https://…" }
//   <builtinSkillsDir>/<name>/SKILL.md   AgentDeck 自带的 skill（组装时由 builtinSkillFiles() 写出）
// 只读写这几个目录，不碰用户自己的配置和仓库。目录都由组装方传入。

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentDeckError, MCP_SERVER_NAME } from '@agentdeck/contracts';
import type { AbsPath, SkillItem, SkillSource } from '@agentdeck/contracts';
import { splitCommand } from '../env.ts';
import type { McpServerDef } from './types.ts';

/** 库里的名字（文件夹名、MCP 服务名）：字母或数字开头，字母、数字、. - _。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** MCP 服务名还要能直接放进 codex 的 `-c mcp_servers.<名>.…`（不带引号的 TOML 键），所以不许有点。 */
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 复制 skill 文件夹时跳过的（版本库、依赖）。 */
const SKIP_COPY = new Set(['.git', 'node_modules', '.DS_Store']);
/** skill 文件夹最多复制这么多（防止误选了整个仓库）。 */
const MAX_SKILL_BYTES = 20 * 1024 * 1024;

export interface SkillFrontmatter {
  name: string | null;
  description: string | null;
}

/** SKILL.md 开头 `---` 之间的 name、description（只认单行的 `key: value`，值可以带引号；`>`、`|` 多行时取下面缩进的几行）。 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const out: SkillFrontmatter = { name: null, description: null };
  // 去掉开头的 BOM（U+FEFF）
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') break;
    const m = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(' ');
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value !== '') out[m[1] as 'name' | 'description'] = value;
  }
  return out;
}

export function skillItemId(source: SkillSource, name: string): string {
  return `skill:${source}:${name}`;
}

export function mcpItemId(source: 'built-in' | 'library', name: string): string {
  return `mcp:${source}:${name}`;
}

/** 一个 skill 文件夹 → SkillItem；没有 SKILL.md 返回 null。 */
export async function readSkillFolder(dir: AbsPath, source: SkillSource, idName?: string): Promise<SkillItem | null> {
  let text: string;
  try {
    text = await readFile(join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const fm = parseSkillFrontmatter(text);
  const folder = basename(dir);
  return {
    id: skillItemId(source, idName ?? folder),
    kind: 'skill',
    name: fm.name ?? folder,
    description: fm.description,
    source,
    path: dir,
    detail: null,
  };
}

/** 一个目录下的每个 skill 文件夹（<dir>/<name>/SKILL.md），按名字排。目录不在返回空。 */
export async function listSkillFolders(dir: AbsPath, source: SkillSource, idPrefix?: string): Promise<SkillItem[]> {
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name);
  } catch {
    return [];
  }
  const items = await Promise.all(names.map((n) => readSkillFolder(join(dir, n), source, idPrefix ? `${idPrefix}/${n}` : n)));
  return items.filter((i): i is SkillItem => i !== null).sort((a, b) => a.name.localeCompare(b.name));
}

export function mcpDetail(def: McpServerDef): string {
  return def.transport === 'http' ? def.url : [def.command, ...def.args].join(' ');
}

/** <mcpDir>/<name>.json 的内容 → McpServerDef；认不出返回 null。 */
export function parseMcpFile(name: string, text: string): McpServerDef | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url === 'string' && r.url !== '') return { name, transport: 'http', url: r.url };
  if (typeof r.command === 'string' && r.command !== '') {
    const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : [];
    return { name, transport: 'stdio', command: r.command, args };
  }
  return null;
}

export interface SkillLibraryDirs {
  /** 库里的 skill（Add skill… 复制到这里）。 */
  skillsDir: AbsPath;
  /** 库里的 MCP 服务。 */
  mcpDir: AbsPath;
  /** AgentDeck 自带的 skill。 */
  builtinSkillsDir: AbsPath;
}

export class SkillLibrary {
  constructor(readonly dirs: SkillLibraryDirs) {}

  builtinSkills(): Promise<SkillItem[]> {
    return listSkillFolders(this.dirs.builtinSkillsDir, 'built-in');
  }

  librarySkills(): Promise<SkillItem[]> {
    return listSkillFolders(this.dirs.skillsDir, 'library');
  }

  async mcpServers(): Promise<McpServerDef[]> {
    let files: string[];
    try {
      files = (await readdir(this.dirs.mcpDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const defs = await Promise.all(
      files.map(async (f) => {
        const name = f.slice(0, -'.json'.length);
        if (!MCP_NAME_RE.test(name) || name === MCP_SERVER_NAME) return null;
        try {
          return parseMcpFile(name, await readFile(join(this.dirs.mcpDir, f), 'utf8'));
        } catch {
          return null;
        }
      }),
    );
    return defs.filter((d): d is McpServerDef => d !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  async mcpItems(): Promise<SkillItem[]> {
    return (await this.mcpServers()).map((d) => ({
      id: mcpItemId('library', d.name),
      kind: 'mcp',
      name: d.name,
      description: null,
      source: 'library',
      path: null,
      detail: mcpDetail(d),
    }));
  }

  /** built-in 和 library 的 skill、库里的 MCP（不含 built-in 的 agentdeck MCP，那个由服务加）。 */
  async items(): Promise<SkillItem[]> {
    const [builtin, library, mcp] = await Promise.all([this.builtinSkills(), this.librarySkills(), this.mcpItems()]);
    return [...builtin, ...library, ...mcp];
  }

  /**
   * Add skill…：把 folder 复制成 <skillsDir>/<name>。name 用 SKILL.md 的 name（不合规时用文件夹名）。
   * 没有 SKILL.md、重名、太大时抛 invalid-argument。先复制到临时目录再改名，复制一半失败不留半个 skill。
   */
  async addSkill(folder: AbsPath): Promise<SkillItem> {
    const probe = await readSkillFolder(folder, 'library');
    if (!probe) throw invalid(`${basename(folder)} has no SKILL.md`, 'A skill is a folder with a SKILL.md file in it.');
    const name = [probe.name, basename(folder)].find((n) => NAME_RE.test(n));
    if (!name) throw invalid(`“${probe.name}” can’t be used as a folder name`);
    const dest = join(this.dirs.skillsDir, name);
    if (await exists(dest)) throw invalid(`A skill named ${name} is already in the library`);
    if ((await folderSize(folder, MAX_SKILL_BYTES)) > MAX_SKILL_BYTES) throw invalid(`${basename(folder)} is too large for a skill (over 20 MB)`);
    await mkdir(this.dirs.skillsDir, { recursive: true });
    const tmp = join(this.dirs.skillsDir, `.adding-${randomUUID()}`);
    try {
      await cp(folder, tmp, { recursive: true, dereference: true, filter: (src) => !SKIP_COPY.has(basename(src)) });
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
    const item = await readSkillFolder(dest, 'library');
    if (!item) throw new AgentDeckError({ code: 'internal', message: `Couldn’t read ${name} after copying it` });
    return item;
  }

  /** Add MCP…：写 <mcpDir>/<name>.json。命令按 shell 规则拆开存成 command + args。 */
  async addMcp(req: { name: string; command?: string; url?: string }): Promise<SkillItem> {
    const name = req.name.trim();
    if (!MCP_NAME_RE.test(name)) throw invalid('Use letters, numbers, - and _ for the name');
    if (name === MCP_SERVER_NAME) throw invalid(`${MCP_SERVER_NAME} is AgentDeck’s own MCP server`);
    const command = req.command?.trim() ?? '';
    const url = req.url?.trim() ?? '';
    if ((command === '') === (url === '')) throw invalid('Enter a command or a URL');
    let body: Record<string, unknown>;
    if (url !== '') {
      if (!/^https?:\/\/\S+$/i.test(url)) throw invalid('The URL must start with http:// or https://');
      body = { url };
    } else {
      const [cmd, ...args] = splitCommand(command);
      if (!cmd) throw invalid('Enter a command or a URL');
      body = { command: cmd, args };
    }
    const file = join(this.dirs.mcpDir, `${name}.json`);
    if (await exists(file)) throw invalid(`An MCP server named ${name} is already in the library`);
    await mkdir(this.dirs.mcpDir, { recursive: true });
    await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });
    const def = parseMcpFile(name, JSON.stringify(body))!;
    return { id: mcpItemId('library', name), kind: 'mcp', name, description: null, source: 'library', path: null, detail: mcpDetail(def) };
  }
}

function invalid(message: string, detail?: string): AgentDeckError {
  return new AgentDeckError({ code: 'invalid-argument', message, ...(detail ? { detail } : {}) });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 文件夹大小，超过 limit 就提前停（返回已经超过的值）。 */
async function folderSize(dir: string, limit: number): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (total > limit || SKIP_COPY.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}

/** AgentDeck 自带的 skill：<名字>/<相对路径> → 内容。组装方写进 builtinSkillsDir（每次启动重写）。 */
export function builtinSkillFiles(): Record<string, string> {
  const skill = [
    '---',
    'name: agentdeck',
    'description: Use when working inside AgentDeck (a board of terminals and browser windows) to show work to the user - open parallel subagent terminals, open a dev server or HTML page in a browser window next to you, notify the user, or look at other terminals.',
    '---',
    '',
    '# Working inside AgentDeck',
    '',
    'You run in a terminal on the AgentDeck board. The user watches terminals and browser windows side by side, so put work where they can see it.',
    'The tools come from the `agentdeck` MCP server (in Claude Code they are named `mcp__agentdeck__<tool>`).',
    '',
    '- Parallel work the user should watch: `open_terminals` with one prompt per subagent. They open as a group next to you. Prefer this over hidden background tasks.',
    '- A dev server or an HTML report: `open_browser` with its URL or file path. It opens next to your terminal.',
    '- Finished, or need a review: `notify` with one short sentence. `focus_window` brings a specific window to the front.',
    '- What else is on the board: `list_windows`, `list_terminals`; follow up with `read_terminal` and `send_to_terminal`.',
    '- Work on a separate git branch: `create_workspace` (a new worktree shown as its own frame).',
    '',
    'If the agentdeck tools are not available, this terminal was started without AgentDeck’s MCP server; carry on normally.',
    '',
  ].join('\n');
  return { 'agentdeck/SKILL.md': skill };
}
