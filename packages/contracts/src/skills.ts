// Skills · MCP（MVP v3 · N9）：源代码管理面板里的一个小节，跟着聚焦的终端，列出这个终端能用的 skill 和 MCP 服务，
// 按终端勾选。不是插件（docs/plugins.md「不是插件的东西」）。
// 实现：packages/agent-adapters 的 skills 模块（主进程）；界面：packages/ui/panels/scm 的 SkillsSection。
//
// 只通过启动参数和环境变量带给 agent，不写用户自己的配置（~/.claude*、~/.codex、~/.pi、~/.omp、~/.kimi-code），
// 也不往用户的仓库里放文件。改了选择要重启 agent 才生效（终端的 Restart and resume）。
// 每个终端的选择随白板保存（TerminalWindowData.skills），启动时主进程按它算启动参数。

import type { AbsPath, AgentKind, TerminalId } from './common.ts';

/**
 * 一项 skill 或 MCP 的 id，随白板保存的选择里存它。形如 `<kind>:<source>:<name>`：
 * 'skill:built-in:agentdeck'、'skill:library:xlsx'、'mcp:built-in:agentdeck'、'mcp:library:github'；
 * repo 的 skill 是 'skill:repo:<相对仓库根的文件夹>'，例如 'skill:repo:.claude/skills/release-notes'。
 */
export type SkillItemId = string;

/**
 * built-in：AgentDeck 自带（agentdeck skill、agentdeck MCP）。
 * repo：仓库里已经有的（例如 .claude/skills/），跟着仓库，AgentDeck 不能开关、不改它。
 * library：AgentDeck 自己的库（数据目录下的 skills/、mcp/），用 Add skill… / Add MCP… 加进来。
 */
export type SkillSource = 'built-in' | 'repo' | 'library';

export interface SkillItem {
  id: SkillItemId;
  kind: 'skill' | 'mcp';
  /** skill 的 name（SKILL.md 开头的 name，没有时是文件夹名）；MCP 服务名。 */
  name: string;
  /** SKILL.md 的 description。没有为 null。 */
  description: string | null;
  source: SkillSource;
  /** skill 的文件夹。MCP 为 null。 */
  path: AbsPath | null;
  /** MCP 怎么连，给人看：命令行或 url。skill 为 null。 */
  detail: string | null;
}

/** forTerminal 里的一项：在 SkillItem 上加这个终端的情况。 */
export interface TerminalSkillItem extends SkillItem {
  /** 白板上没存选择时勾不勾：built-in 勾，library 不勾，repo 跟着仓库（总是勾着）。 */
  defaultOn: boolean;
  /** 能不能在 AgentDeck 里开关：repo 的不能；这个 agent 不支持时不能。 */
  toggleable: boolean;
  /** 不能开关的原因或说明（英文），例如 'Follows the repo'、'Not supported for kimi'。 */
  note: string | null;
  /** MCP 服务的状态，知道时才有（built-in 的 agentdeck：AgentDeck 的 MCP 服务起来了没有）。 */
  status: 'running' | 'error' | null;
}

export interface TerminalSkills {
  terminalId: TerminalId;
  /** 不认识的终端为 null（items 为空）。 */
  agent: AgentKind | null;
  items: TerminalSkillItem[];
  /**
   * 正在跑的 agent 启动时带上的、能开关的项（built-in 和 library）。
   * 不知道（不是这个版本的 AgentDeck 启动的）为 null。和白板上的选择不同时界面提示 “Changes apply after restart”。
   */
  running: SkillItemId[] | null;
}

export interface AddMcpRequest {
  /** 服务名：字母、数字、- 和 _，例如 'github'。 */
  name: string;
  /** 本地命令（stdio），例如 'npx -y @modelcontextprotocol/server-github'。和 url 二选一。 */
  command?: string;
  /** http(s) 地址（streamable HTTP）。 */
  url?: string;
}

export interface SkillsService {
  /** 这个终端（按它的 agent 和目录）能用的 skill 和 MCP。 */
  forTerminal(terminalId: TerminalId): Promise<TerminalSkills>;
  /** AgentDeck 的库：built-in 和 library 的项。 */
  library(): Promise<SkillItem[]>;
  /** Add skill…：把一个有 SKILL.md 的文件夹复制进库。重名、没有 SKILL.md 时抛 invalid-argument。 */
  addSkill(folder: AbsPath): Promise<SkillItem>;
  /** Add MCP…：在库里登记一个 MCP 服务。重名、名字或地址不对时抛 invalid-argument。 */
  addMcp(req: AddMcpRequest): Promise<SkillItem>;
}

/** 库变了（加了 skill 或 MCP）。面板重取 forTerminal。 */
export type SkillsEvent = { type: 'skills.library-changed'; items: SkillItem[] };

/**
 * 这个终端选了哪些能开关的项：白板上存了选择就用它（只留能开关的），没存（null）按 defaultOn。
 * 界面显示勾选、主进程算启动参数都用它，规则只有这一份。
 */
export function effectiveSkillSelection(
  items: readonly Pick<TerminalSkillItem, 'id' | 'toggleable' | 'defaultOn'>[],
  selection: readonly SkillItemId[] | null | undefined,
): SkillItemId[] {
  const toggleable = items.filter((i) => i.toggleable);
  if (selection == null) return toggleable.filter((i) => i.defaultOn).map((i) => i.id);
  const chosen = new Set(selection);
  return toggleable.filter((i) => chosen.has(i.id)).map((i) => i.id);
}

/**
 * 要不要提示 “Changes apply after restart”：选的和正在跑的 agent 启动时带的不一样。
 * running 不知道（null）时，只有选择改过默认值才提示。
 */
export function skillsRestartNeeded(
  items: readonly Pick<TerminalSkillItem, 'id' | 'toggleable' | 'defaultOn'>[],
  selection: readonly SkillItemId[] | null | undefined,
  running: readonly SkillItemId[] | null,
): boolean {
  const chosen = effectiveSkillSelection(items, selection);
  const base = running === null ? effectiveSkillSelection(items, null) : effectiveSkillSelection(items, running);
  return chosen.length !== base.length || chosen.some((id) => !base.includes(id));
}
