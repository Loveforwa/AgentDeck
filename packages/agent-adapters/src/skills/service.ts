// SkillsService 的实现（N9），在主进程里。
// - forTerminal：按终端的 agent 和目录列出 built-in、repo、library 的 skill 和 MCP，标出这个 agent 能不能开关；
//   running 是这个终端启动时带上的（noteLaunched 记下，写进 stateFile，重开应用后还在）。
// - prepareLaunch：启动前按白板上存的选择（TerminalWindowData.skills）算这次带什么，claude、omp、kimi 要的那套目录在这里写好。
// 不写用户的配置和仓库：只写 AgentDeck 自己的数据目录（库、setsDir、stateFile）。

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { effectiveSkillSelection, MCP_SERVER_NAME } from '@agentdeck/contracts';
import type {
  AbsPath,
  AddMcpRequest,
  AgentKind,
  SkillItem,
  SkillItemId,
  SkillsEvent,
  SkillsService,
  TerminalId,
  TerminalSkillItem,
  TerminalSkills,
} from '@agentdeck/contracts';
import type { EnvSource } from '../env.ts';
import { mcpItemId, SkillLibrary, type SkillLibraryDirs } from './library.ts';
import { findRepoRoot, scanRepoSkills } from './repo.ts';
import { notSupportedNote, skillsSupport } from './support.ts';
import { SKILL_SET_PLUGIN_NAME, type LaunchSkills, type McpServerDef } from './types.ts';

/** built-in 的 agentdeck MCP 在选择里的 id。 */
export const AGENTDECK_MCP_ID = mcpItemId('built-in', MCP_SERVER_NAME);
/** stateFile 里最多记这么多个终端（旧的丢掉）。 */
const MAX_REMEMBERED = 500;
/** 不能开关的 agent（shell、自定义命令）。 */
const NOT_AN_AGENT = new Set<AgentKind>(['shell', 'custom']);

export interface SkillsServiceOptions extends SkillLibraryDirs {
  /** 每次启动要的那套目录写在这里（例如 <dataDir>/skill-sets），按内容取名，内容一样就复用。 */
  setsDir: AbsPath;
  /** 记每个终端启动时带了什么（running）的文件。不给只记在内存里。 */
  stateFile?: AbsPath;
  /** 终端 id → agent 和目录（状态机、库里的终端记录）。不认识返回 null。 */
  lookup: (terminalId: TerminalId) => { agent: AgentKind; cwd: AbsPath } | null;
  /** AgentDeck 的 MCP 服务起来了没有（built-in agentdeck 的状态点）。不给时不显示状态。 */
  mcpRunning?: () => boolean;
  emit?: (event: SkillsEvent) => void;
  /** 用户主目录（kimi 的 ~/.agents/skills）。 */
  homeDir: AbsPath;
  /** 登录 shell 的环境（kimi 的 KIMI_CODE_HOME）。 */
  env?: EnvSource;
}

export interface PrepareLaunchRequest {
  agent: AgentKind;
  cwd: AbsPath;
  /** 白板上存的选择；null 用默认。 */
  selection: readonly SkillItemId[] | null;
}

export class SkillsServiceImpl implements SkillsService {
  readonly lib: SkillLibrary;
  private readonly running = new Map<TerminalId, SkillItemId[]>();

  constructor(private readonly opts: SkillsServiceOptions) {
    this.lib = new SkillLibrary(opts);
    if (opts.stateFile) {
      try {
        const raw = JSON.parse(readFileSync(opts.stateFile, 'utf8')) as { running?: Record<string, unknown> };
        for (const [id, ids] of Object.entries(raw.running ?? {})) {
          if (Array.isArray(ids)) this.running.set(id as TerminalId, ids.filter((x): x is string => typeof x === 'string'));
        }
      } catch {
        // 第一次运行，或文件坏了：当作什么都不知道
      }
    }
  }

  async forTerminal(terminalId: TerminalId): Promise<TerminalSkills> {
    const t = this.opts.lookup(terminalId);
    if (!t) return { terminalId, agent: null, items: [], running: null };
    return { terminalId, agent: t.agent, items: await this.itemsFor(t.agent, t.cwd), running: this.running.get(terminalId) ?? null };
  }

  async library(): Promise<SkillItem[]> {
    const items = await this.lib.items();
    const skills = items.filter((i) => i.kind === 'skill');
    return [...skills, agentdeckMcpItem(), ...items.filter((i) => i.kind === 'mcp')];
  }

  async addSkill(folder: AbsPath): Promise<SkillItem> {
    const item = await this.lib.addSkill(folder);
    await this.changed();
    return item;
  }

  async addMcp(req: AddMcpRequest): Promise<SkillItem> {
    const item = await this.lib.addMcp(req);
    await this.changed();
    return item;
  }

  /** 这个 agent 在这个目录里能用的项，顺序：built-in skill、repo、library skill、built-in MCP、library MCP。 */
  async itemsFor(agent: AgentKind, cwd: AbsPath): Promise<TerminalSkillItem[]> {
    if (NOT_AN_AGENT.has(agent)) return [];
    const sup = skillsSupport(agent);
    const unsupported = notSupportedNote(agent);
    const [builtin, library, mcp, repo] = await Promise.all([
      this.lib.builtinSkills(),
      this.lib.librarySkills(),
      this.lib.mcpItems(),
      scanRepoSkills(cwd, sup.repoDirs),
    ]);
    const skillRow = (i: SkillItem, defaultOn: boolean): TerminalSkillItem => ({
      ...i,
      defaultOn,
      toggleable: sup.skills !== null,
      note: sup.skills !== null ? null : unsupported,
      status: null,
    });
    const mcpRow = (i: SkillItem, defaultOn: boolean, status: TerminalSkillItem['status']): TerminalSkillItem => ({
      ...i,
      defaultOn,
      toggleable: sup.mcp !== null,
      note: sup.mcp !== null ? null : unsupported,
      status: sup.mcp !== null ? status : null,
    });
    const up = this.opts.mcpRunning?.();
    return [
      ...builtin.map((i) => skillRow(i, true)),
      ...repo.map((i): TerminalSkillItem => ({ ...i, defaultOn: true, toggleable: false, note: 'Follows the repo', status: null })),
      ...library.map((i) => skillRow(i, false)),
      mcpRow(agentdeckMcpItem(), true, up === undefined ? null : up ? 'running' : 'error'),
      ...mcp.map((i) => mcpRow(i, false, null)),
    ];
  }

  /** 启动前：按选择算这次带什么，需要的那套目录写好。shell、自定义命令返回 null。 */
  async prepareLaunch(req: PrepareLaunchRequest): Promise<LaunchSkills | null> {
    if (NOT_AN_AGENT.has(req.agent)) return null;
    const sup = skillsSupport(req.agent);
    const items = await this.itemsFor(req.agent, req.cwd);
    const ids = effectiveSkillSelection(items, req.selection);
    const chosen = new Set(ids);
    const byId = new Map(items.map((i) => [i.id, i]));
    const skills: { name: string; path: AbsPath }[] = [];
    const names = new Set<string>();
    for (const id of ids) {
      const i = byId.get(id);
      if (i?.kind !== 'skill' || !i.path) continue;
      const name = basename(i.path);
      if (names.has(name)) continue; // built-in 和库里同名：先列的（built-in）算
      names.add(name);
      skills.push({ name, path: i.path });
    }
    const defs = new Map((await this.lib.mcpServers()).map((d) => [mcpItemId('library', d.name), d]));
    const mcp = ids.flatMap((id) => defs.get(id) ?? []);
    const agentdeckMcp = !byId.get(AGENTDECK_MCP_ID)?.toggleable || chosen.has(AGENTDECK_MCP_ID);

    let setDir: AbsPath | null = null;
    if ((sup.skills === 'plugin-dir' || sup.skills === 'skills-dir') && (skills.length > 0 || (sup.mcp === 'plugin-dir' && mcp.length > 0))) {
      setDir = await this.writeSet(req.agent, skills, sup.mcp === 'plugin-dir' ? mcp : []);
    }
    const keepSkillRoots = sup.skills === 'skills-dir' && skills.length > 0 ? await this.kimiRoots(req.cwd) : [];
    return { ids, agentdeckMcp, skills, mcp, setDir, keepSkillRoots };
  }

  /** 终端起来了：记下它带了什么（running）。 */
  noteLaunched(terminalId: TerminalId, ids: readonly SkillItemId[]): void {
    this.running.delete(terminalId);
    this.running.set(terminalId, [...ids]);
    while (this.running.size > MAX_REMEMBERED) this.running.delete(this.running.keys().next().value!);
    this.save();
  }

  runningFor(terminalId: TerminalId): SkillItemId[] | null {
    return this.running.get(terminalId) ?? null;
  }

  private async changed(): Promise<void> {
    this.opts.emit?.({ type: 'skills.library-changed', items: await this.library() });
  }

  private save(): void {
    if (!this.opts.stateFile) return;
    const body = JSON.stringify({ running: Object.fromEntries(this.running) }, null, 1);
    void writeFile(this.opts.stateFile, `${body}\n`).catch(() => undefined);
  }

  /**
   * 写一套目录：skills/<name>/ 是 skill 的副本，.claude-plugin/plugin.json 是清单（omp 时带库里的 MCP）。
   * 目录名是内容的哈希（skill 文件的大小和修改时间也算进去），一样就直接用，不重写正在被别的终端用的目录。
   */
  private async writeSet(agent: AgentKind, skills: { name: string; path: AbsPath }[], mcp: McpServerDef[]): Promise<AbsPath> {
    const prints = await Promise.all(skills.map(async (s) => ({ name: s.name, files: await fingerprint(s.path) })));
    const manifest = setManifest(mcp);
    const key = createHash('sha256').update(JSON.stringify({ v: 1, agent, prints, manifest })).digest('hex').slice(0, 16);
    const dir = join(this.opts.setsDir, `${agent}-${key}`);
    if (await exists(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    const tmp = `${dir}.tmp-${randomUUID()}`;
    try {
      await mkdir(join(tmp, '.claude-plugin'), { recursive: true });
      await mkdir(join(tmp, 'skills'), { recursive: true });
      for (const s of skills) await cp(s.path, join(tmp, 'skills', s.name), { recursive: true, dereference: true });
      await writeFile(join(tmp, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      await rename(tmp, dir).catch(async (e: unknown) => {
        // 同时有另一次启动写好了同一套：用它的
        if (await exists(join(dir, '.claude-plugin', 'plugin.json'))) return;
        throw e;
      });
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
    return dir;
  }

  /** kimi 自己会发现的 skill 目录（存在的）：$KIMI_CODE_HOME/skills、~/.agents/skills、<仓库根>/.kimi-code/skills、<仓库根>/.agents/skills。 */
  private async kimiRoots(cwd: AbsPath): Promise<AbsPath[]> {
    const env = this.opts.env?.() ?? {};
    const kimiHome = env['KIMI_CODE_HOME'] || join(this.opts.homeDir, '.kimi-code');
    const root = (await findRepoRoot(cwd)) ?? cwd;
    const candidates = [join(kimiHome, 'skills'), join(this.opts.homeDir, '.agents', 'skills'), join(root, '.kimi-code', 'skills'), join(root, '.agents', 'skills')];
    const out: AbsPath[] = [];
    for (const c of candidates) if (await isDir(c)) out.push(c);
    return out;
  }
}

export function agentdeckMcpItem(): SkillItem {
  return {
    id: AGENTDECK_MCP_ID,
    kind: 'mcp',
    name: MCP_SERVER_NAME,
    description: 'AgentDeck board tools: open terminals and browser windows next to you, list windows, notify the user.',
    source: 'built-in',
    path: null,
    detail: 'AgentDeck board tools',
  };
}

/** 那套目录的插件清单。MCP 服务的写法是 Claude 插件格式（omp 认它，N1）。 */
export function setManifest(mcp: readonly McpServerDef[]): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: SKILL_SET_PLUGIN_NAME,
    description: 'Skills and MCP servers AgentDeck adds to this terminal.',
  };
  if (mcp.length > 0) {
    manifest.mcpServers = Object.fromEntries(
      mcp.map((d) => [d.name, d.transport === 'http' ? { type: 'http', url: d.url } : { command: d.command, args: d.args }]),
    );
  }
  return manifest;
}

async function fingerprint(dir: AbsPath): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const s = await stat(p).catch(() => null);
        if (s) out.push(`${relative(dir, p)}:${s.size}:${Math.round(s.mtimeMs)}`);
      }
    }
  };
  await walk(dir);
  return out.sort();
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
