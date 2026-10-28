// SkillsService 的实现（N9），在主进程里。
// - forTerminal：按终端的 agent 和目录列出 built-in、repo、library 的 skill 和 MCP，标出这个 agent 能不能开关；
//   running 是这个终端启动时带上的（noteLaunched 记下，写进 stateFile，重开应用后还在）。
// - prepareLaunch：启动前按白板上存的选择（TerminalWindowData.skills）算这次带什么，claude、omp、kimi 要的那套目录在这里写好。
// 不写用户的配置和仓库：只写 AgentDeck 自己的数据目录（库、setsDir、stateFile）。

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
/** setsDir 里超过这么久没动的目录，没有终端在用就删（IS-112）。 */
export const SKILL_SETS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 每天清理一次。 */
export const SKILL_SETS_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** AgentDeck 自己生成的目录名：<agent>-<16 位哈希>，写到一半留下的是 <名字>.tmp-<uuid>。别的名字一律不碰。 */
const SET_DIR_NAME = /^[a-z][a-z0-9_-]*-[0-9a-f]{16}(\.tmp-[0-9a-f-]{36})?$/;

export interface SkillsServiceOptions extends SkillLibraryDirs {
  /** 每次启动要的那套目录写在这里（例如 <dataDir>/skill-sets），按内容取名，内容一样就复用。 */
  setsDir: AbsPath;
  /** 记每个终端启动时带了什么（running）的文件。不给只记在内存里。 */
  stateFile?: AbsPath;
  /** 终端 id → agent 和目录（状态机、库里的终端记录）。不认识返回 null。 */
  lookup: (terminalId: TerminalId) => { agent: AgentKind; cwd: AbsPath } | null;
  /** AgentDeck 的 MCP 服务起来了没有（built-in agentdeck 的状态点）。不给时不显示状态。 */
  mcpRunning?: () => boolean;
  /**
   * 现在在 tmux 里还活着的终端（清理 setsDir 用，IS-112）。抛错时这一轮不清理。
   * 不给时，stateFile 里记过的每个终端都算在用（只会少删，不会误删）。
   */
  liveTerminals?: () => Promise<readonly TerminalId[]> | readonly TerminalId[];
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

/** 一次清理的结果（给日志和测试）。 */
export interface SkillSetsCleanup {
  /** 删掉的目录名。 */
  removed: string[];
  /** 留下的目录数（在用的、不到 7 天的、不是 AgentDeck 生成的）。 */
  kept: number;
  /** 这一轮没做的原因；做了为 null。 */
  skipped: 'no-live-list' | 'unknown-terminal' | null;
}

export class SkillsServiceImpl implements SkillsService {
  readonly lib: SkillLibrary;
  private readonly running = new Map<TerminalId, SkillItemId[]>();
  /** 终端启动时用的那套目录（null 是没用）。没有记录的终端（旧版本启动的）清理时当作不知道。 */
  private readonly sets = new Map<TerminalId, AbsPath | null>();
  private cleaning: Promise<SkillSetsCleanup> | null = null;
  /** prepareLaunch 刚给出去、可能还没来得及 noteLaunched 的目录名，几分钟内清理不碰。 */
  private readonly fresh = new Set<string>();

  constructor(private readonly opts: SkillsServiceOptions) {
    this.lib = new SkillLibrary(opts);
    if (opts.stateFile) {
      try {
        const raw = JSON.parse(readFileSync(opts.stateFile, 'utf8')) as { running?: Record<string, unknown>; sets?: Record<string, unknown> };
        for (const [id, ids] of Object.entries(raw.running ?? {})) {
          if (Array.isArray(ids)) this.running.set(id as TerminalId, ids.filter((x): x is string => typeof x === 'string'));
        }
        for (const [id, dir] of Object.entries(raw.sets ?? {})) {
          if (typeof dir === 'string' || dir === null) this.sets.set(id as TerminalId, dir);
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

  /** 终端起来了：记下它带了什么（running）和用的那套目录（setDir，清理时认）。 */
  noteLaunched(terminalId: TerminalId, ids: readonly SkillItemId[], setDir: AbsPath | null = null): void {
    this.running.delete(terminalId);
    this.sets.delete(terminalId);
    this.running.set(terminalId, [...ids]);
    this.sets.set(terminalId, setDir);
    while (this.running.size > MAX_REMEMBERED) {
      const oldest = this.running.keys().next().value!;
      this.running.delete(oldest);
      this.sets.delete(oldest);
    }
    this.save();
  }

  /**
   * 清理 setsDir（IS-112）：列出里面 AgentDeck 生成的目录，正在被终端用的不动，别的超过 7 天的删掉。
   * 在用 = 还活着的终端（liveTerminals）启动时记下的 setDir；没有 liveTerminals 时，记过的每个终端都算。
   * 活着的终端里有 agent 会用到这类目录、却没有记录的（旧版本启动的），这一轮不删，免得删掉它正在读的目录。
   * 每个要删的路径删之前都确认在 setsDir 里面，符号链接和不是目录的不碰。同时只跑一个。
   */
  cleanupSkillSets(now: number = Date.now(), maxAgeMs: number = SKILL_SETS_MAX_AGE_MS): Promise<SkillSetsCleanup> {
    this.cleaning ??= this.doCleanup(now, maxAgeMs).finally(() => {
      this.cleaning = null;
    });
    return this.cleaning;
  }

  private async doCleanup(now: number, maxAgeMs: number): Promise<SkillSetsCleanup> {
    const setsDir = resolve(this.opts.setsDir);
    let alive: readonly TerminalId[];
    if (this.opts.liveTerminals) {
      try {
        alive = await this.opts.liveTerminals();
      } catch {
        return { removed: [], kept: 0, skipped: 'no-live-list' };
      }
    } else {
      alive = [...new Set([...this.running.keys(), ...this.sets.keys()])];
    }
    const inUse = new Set<string>();
    for (const id of alive) {
      if (this.sets.has(id)) {
        const dir = this.sets.get(id);
        if (dir) {
          const name = insideName(setsDir, dir);
          if (name) inUse.add(name);
        }
        continue;
      }
      // 没有记录：不用这类目录的 agent（shell、codex、pi……）没关系，会用的就是不知道它用哪个
      const agent = this.opts.lookup(id)?.agent;
      if (agent && !NOT_AN_AGENT.has(agent) && ['plugin-dir', 'skills-dir'].includes(skillsSupport(agent).skills ?? '')) {
        return { removed: [], kept: 0, skipped: 'unknown-terminal' };
      }
    }
    // 刚算好、终端还没起来的目录（prepareLaunch 和 noteLaunched 之间）
    for (const name of this.fresh) inUse.add(name);

    let names: string[];
    try {
      names = await readdir(setsDir);
    } catch {
      return { removed: [], kept: 0, skipped: null };
    }
    const removed: string[] = [];
    let kept = 0;
    for (const name of names) {
      const path = join(setsDir, name);
      if (!SET_DIR_NAME.test(name) || insideName(setsDir, path) !== name || inUse.has(name.replace(/\.tmp-.*$/, ''))) {
        kept++;
        continue;
      }
      try {
        const st = await lstat(path);
        if (!st.isDirectory() || now - st.mtimeMs <= maxAgeMs) {
          kept++;
          continue;
        }
        await rm(path, { recursive: true, force: true });
        removed.push(name);
      } catch {
        kept++;
      }
    }
    return { removed, kept, skipped: null };
  }

  runningFor(terminalId: TerminalId): SkillItemId[] | null {
    return this.running.get(terminalId) ?? null;
  }

  private markFresh(name: string): void {
    this.fresh.add(name);
    setTimeout(() => this.fresh.delete(name), 10 * 60 * 1000).unref();
  }

  private async changed(): Promise<void> {
    this.opts.emit?.({ type: 'skills.library-changed', items: await this.library() });
  }

  private save(): void {
    if (!this.opts.stateFile) return;
    const body = JSON.stringify({ running: Object.fromEntries(this.running), sets: Object.fromEntries(this.sets) }, null, 1);
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
    this.markFresh(basename(dir));
    if (await exists(join(dir, '.claude-plugin', 'plugin.json'))) {
      // 复用：把修改时间更新到现在，清理时不会因为“旧”而删掉刚被新终端选中的目录
      const t = new Date();
      await utimes(dir, t, t).catch(() => undefined);
      return dir;
    }
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

/** p 在 root 里面（不是 root 自己）时返回它在 root 下的第一层名字，否则 null。 */
function insideName(root: string, p: string): string | null {
  const rel = relative(root, resolve(p));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const first = rel.split(sep)[0]!;
  return first && first !== '..' ? first : null;
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
