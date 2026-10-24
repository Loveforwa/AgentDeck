// SkillsService 的假实现（N9 · Skills · MCP）：内存里的库（built-in 的 agentdeck skill 和 MCP、预置的 library 项）、
// 按目录预置的 repo skill、按 agent 的支持情况（和 packages/agent-adapters 的 skills/support.ts 一致：claude、omp 全支持，
// codex 只有 MCP，pi、kimi 只有 skill，shell 和自定义命令什么都没有）。setRunning 预置某个终端启动时带了什么。

import { AgentDeckError } from '@agentdeck/contracts';
import type {
  AbsPath,
  AddMcpRequest,
  AgentKind,
  SkillItem,
  SkillItemId,
  SkillsService,
  TerminalId,
  TerminalSkillItem,
  TerminalSkills,
} from '@agentdeck/contracts';
import { FakeEventBus } from './bus.ts';

export interface FakeSkillsServiceOptions {
  bus?: FakeEventBus;
  /** 终端 id → agent 和目录。不认识返回 null。 */
  lookup?: (terminalId: TerminalId) => { agent: AgentKind; cwd: AbsPath } | null;
}

const SUPPORT: Record<string, { skills: boolean; mcp: boolean }> = {
  claude: { skills: true, mcp: true },
  omp: { skills: true, mcp: true },
  codex: { skills: false, mcp: true },
  pi: { skills: true, mcp: false },
  kimi: { skills: true, mcp: false },
};

export const FAKE_BUILTIN: readonly SkillItem[] = [
  {
    id: 'skill:built-in:agentdeck',
    kind: 'skill',
    name: 'agentdeck',
    description: 'Use when working inside AgentDeck to show work to the user.',
    source: 'built-in',
    path: '/Users/me/.agentdeck/builtin/skills/agentdeck',
    detail: null,
  },
  {
    id: 'mcp:built-in:agentdeck',
    kind: 'mcp',
    name: 'agentdeck',
    description: 'AgentDeck board tools.',
    source: 'built-in',
    path: null,
    detail: 'AgentDeck board tools',
  },
];

export class FakeSkillsService implements SkillsService {
  private readonly bus: FakeEventBus;
  private readonly lookup: NonNullable<FakeSkillsServiceOptions['lookup']>;
  /** library 的项（skill 和 MCP）。 */
  readonly libraryItems: SkillItem[] = [];
  /** 目录 → 那里的 repo skill。 */
  private readonly repo = new Map<AbsPath, SkillItem[]>();
  private readonly running = new Map<TerminalId, SkillItemId[]>();
  /** addSkill 收到的文件夹。 */
  readonly addedFolders: AbsPath[] = [];
  /** AgentDeck 的 MCP 服务的状态点。 */
  mcpStatus: 'running' | 'error' | null = 'running';

  constructor(opts: FakeSkillsServiceOptions = {}) {
    this.bus = opts.bus ?? new FakeEventBus();
    this.lookup = opts.lookup ?? (() => null);
  }

  async forTerminal(terminalId: TerminalId): Promise<TerminalSkills> {
    const t = this.lookup(terminalId);
    if (!t) return { terminalId, agent: null, items: [], running: null };
    return structuredClone({ terminalId, agent: t.agent, items: this.itemsFor(t.agent, t.cwd), running: this.running.get(terminalId) ?? null });
  }

  async library(): Promise<SkillItem[]> {
    return structuredClone([...FAKE_BUILTIN, ...this.libraryItems]);
  }

  async addSkill(folder: AbsPath): Promise<SkillItem> {
    this.addedFolders.push(folder);
    const name = folder.split('/').filter(Boolean).pop() ?? 'skill';
    if (this.libraryItems.some((i) => i.kind === 'skill' && i.name === name)) {
      throw new AgentDeckError({ code: 'invalid-argument', message: `A skill named ${name} is already in the library` });
    }
    const item: SkillItem = { id: `skill:library:${name}`, kind: 'skill', name, description: null, source: 'library', path: `/Users/me/.agentdeck/skills/${name}`, detail: null };
    this.addLibrary(item);
    return structuredClone(item);
  }

  async addMcp(req: AddMcpRequest): Promise<SkillItem> {
    const name = req.name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new AgentDeckError({ code: 'invalid-argument', message: 'Use letters, numbers, - and _ for the name' });
    if (name === 'agentdeck' || this.libraryItems.some((i) => i.kind === 'mcp' && i.name === name)) {
      throw new AgentDeckError({ code: 'invalid-argument', message: `An MCP server named ${name} is already in the library` });
    }
    const detail = req.url?.trim() || req.command?.trim() || '';
    if (detail === '') throw new AgentDeckError({ code: 'invalid-argument', message: 'Enter a command or a URL' });
    const item: SkillItem = { id: `mcp:library:${name}`, kind: 'mcp', name, description: null, source: 'library', path: null, detail };
    this.addLibrary(item);
    return structuredClone(item);
  }

  // ---- 控制方法 ----

  /** 往库里加一项（预置数据用），发 skills.library-changed。 */
  addLibrary(item: SkillItem): void {
    this.libraryItems.push(item);
    this.bus.emit({ type: 'skills.library-changed', items: structuredClone([...FAKE_BUILTIN, ...this.libraryItems]) });
  }

  /** 预置一个目录里的 repo skill。 */
  setRepoSkills(cwd: AbsPath, names: string[]): void {
    this.repo.set(
      cwd,
      names.map((name) => ({
        id: `skill:repo:.claude/skills/${name}`,
        kind: 'skill',
        name,
        description: null,
        source: 'repo',
        path: `${cwd}/.claude/skills/${name}`,
        detail: null,
      })),
    );
  }

  /** 预置这个终端启动时带了什么（null = 不知道）。 */
  setRunning(terminalId: TerminalId, ids: SkillItemId[] | null): void {
    if (ids === null) this.running.delete(terminalId);
    else this.running.set(terminalId, [...ids]);
  }

  private itemsFor(agent: AgentKind, cwd: AbsPath): TerminalSkillItem[] {
    if (agent === 'shell' || agent === 'custom') return [];
    const sup = SUPPORT[agent] ?? { skills: false, mcp: false };
    const note = `Not supported for ${agent}`;
    const row = (i: SkillItem, defaultOn: boolean): TerminalSkillItem => {
      const ok = i.kind === 'skill' ? sup.skills : sup.mcp;
      const status = i.id === 'mcp:built-in:agentdeck' && ok ? this.mcpStatus : null;
      return { ...i, defaultOn, toggleable: ok, note: ok ? null : note, status };
    };
    const lib = this.libraryItems;
    return [
      row(FAKE_BUILTIN[0]!, true),
      // 预置的 repo skill 在 .claude/skills 里：只有 claude 和 omp 会读（真实现按每种 agent 自己读的目录找）
      ...(agent === 'claude' || agent === 'omp' ? (this.repo.get(cwd) ?? []) : []).map((i): TerminalSkillItem => ({ ...i, defaultOn: true, toggleable: false, note: 'Follows the repo', status: null })),
      ...lib.filter((i) => i.kind === 'skill').map((i) => row(i, false)),
      row(FAKE_BUILTIN[1]!, true),
      ...lib.filter((i) => i.kind === 'mcp').map((i) => row(i, false)),
    ];
  }
}
