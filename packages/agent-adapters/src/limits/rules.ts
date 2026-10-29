// 额度上限（插件 Auto-resume，M7 · PL5）的纯规则：账号键、范围、开关怎么算、续跑提示词、各种时长。
// 不碰时钟、不碰服务，service.ts 和测试都用它。需求见设计画布“MVP 插件”页 PluginResume，调研 DR-63、DR-84。
//
// Prompt queue（PL3）2026-10-28 退役，原来和它各写一份的几个数现在只在这里（界面的 Auto-resume 书签只读 LimitService 的列表）。

import type {
  AbsPath,
  AccountKey,
  AgentKind,
  BackgroundAgent,
  BoardState,
  LimitScope,
  TerminalId,
  TerminalWindowData,
  UsageLimit,
} from '@agentdeck/contracts';
import { atLeast } from '../env.ts';

/** 恢复时间过了再等这么久才续（毫秒）：恢复的那一刻 agent 那边可能还没放开。同 PL3 的 RESUME_GRACE_MS。 */
export const RESUME_GRACE_MS = 60_000;
/** 同一账号几个终端续跑的间隔（毫秒）。AGENTDECK_RESUME_STAGGER_MS 可改（组装方读环境）。 */
export const RESUME_STAGGER_MS = 30_000;
/** claude 从这个版本起默认在额度恢复后自己续跑（autoContinueAtUsageLimit，DR-84）。同 PL3。 */
export const SELF_RESUME_SINCE = '2.1.234';
/** claude 自己会续时：恢复后这么久还没动静（没有 fired、没开始干活），AgentDeck 自己发。同 PL3。 */
export const SELF_RESUME_FALLBACK_MS = 3 * 60_000;
/** 恢复时间离现在超过这么久（每周额度），claude 不自己等，由 AgentDeck 续（DR-84）。 */
export const SELF_RESUME_MAX_WAIT_MS = 24 * 60 * 60_000;
/** 恢复时没看着（Mac 睡着、应用没开），醒来已经过了恢复时间这么久：先问你，不直接续（2026-10-28 用户定）。同 PL3 的 STALE_AFTER_MS。 */
export const SLEPT_AFTER_MS = 30 * 60_000;
/** 两次检查隔了这么久算“中间没看着”（平时 5 秒一次）。同 PL3。 */
export const WATCH_GAP_MS = 150_000;
/** 离恢复不到这么久、有终端在等时不让 Mac 睡；更远（每周额度）不阻止，醒来后过了恢复时间照样续。 */
export const KEEP_AWAKE_WITHIN_MS = 12 * 60 * 60_000;
/** 连续这么多次续了又撞：gave-up，进收件箱。 */
export const MAX_REHITS = 2;
/** 撞上后这么久还读不到恢复时间：needsYou reset-unknown（钩子先到、会话记录还没读到时先等一会儿）。 */
export const RESET_UNKNOWN_AFTER_MS = 60_000;
/** 恢复时间已经过去这么久的上限不再管（重开应用时读到的很久以前的记录）。 */
export const IGNORE_RESET_OLDER_THAN_MS = 12 * 60 * 60_000;
/** 续完那一轮后这么短时间内又撞，仍算“续了又撞”（codex 的 Stop 可能比会话记录先到）。 */
export const REHIT_WINDOW_MS = 2 * 60_000;
/** 子 agent 在主线撞上前这么久之内 failed 的，算“跟着额度断的”。 */
export const SUBAGENT_LOST_BEFORE_MS = 5 * 60_000;

/** 现在认得出额度上限的 agent（DR-63）：claude 读会话记录和钩子，codex 读会话记录。pi、kimi、omp 待 PL9 核对。 */
export const LIMIT_AGENTS = ['claude', 'codex'] as const;

export function isLimitAgent(agent: AgentKind): boolean {
  return (LIMIT_AGENTS as readonly string[]).includes(agent);
}

/** 账号键 `<agent>:<配置目录>:<范围>`。 */
export function accountKey(agent: AgentKind, configDir: AbsPath, scope: LimitScope): AccountKey {
  return `${agent}:${configDir}:${scope}`;
}

/**
 * 这个 agent 的账号在哪个配置目录：claude 是 CLAUDE_CONFIG_DIR（没设是 ~/.claude），codex 是 CODEX_HOME（没设是 ~/.codex）。
 * env 是登录 shell 的环境（AgentDeck 开的 agent 都用它）。认不出额度的 agent 为 null。
 */
export function limitConfigDir(agent: AgentKind, env: Readonly<Record<string, string | undefined>>, home: string): AbsPath | null {
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  if (agent === 'claude') return trim(env['CLAUDE_CONFIG_DIR'] || `${home}/.claude`);
  if (agent === 'codex') return trim(env['CODEX_HOME'] || `${home}/.codex`);
  return null;
}

/** 额度的范围（UsageLimit.scope，contracts 0.1.22）：claude 的 Opus / Sonnet 单独额度由用量模块带上，别的都是 all。 */
export function limitScopeOf(limit: UsageLimit | null | undefined): LimitScope {
  const s = limit?.scope;
  return s === 'opus' || s === 'sonnet' ? s : 'all';
}

/** 这个终端算不算这个范围：all 都算；opus / sonnet 只算最近用的模型是同一家族的（模型不知道时不算）。 */
export function scopeMatches(scope: LimitScope, model: string | null | undefined): boolean {
  if (scope === 'all') return true;
  return typeof model === 'string' && model.toLowerCase().includes(scope);
}

/** claude 会不会在额度恢复后自己续跑（2.1.234 起默认会）。版本读不出时当它会（同 PL3：最多晚 3 分钟，不会盖掉它的续跑）。 */
export function claudeSelfResumes(version: string | null): boolean {
  return atLeast(version, SELF_RESUME_SINCE);
}

/**
 * 这个终端的 Auto-resume 开着没有：终端单独的设置（TerminalWindowData.autoResume）优先，再看框（FrameNode.autoResume），
 * 再看白板（BoardState.autoResume）；都没设是关（2026-10-28 用户定：默认关）。白板上找不到这个终端也算关。
 */
export function effectiveAutoResume(board: BoardState | null, terminalId: TerminalId): boolean {
  if (!board) return false;
  const w = board.windows.find((n) => n.type === 'terminal' && (n.data as Partial<TerminalWindowData> | null)?.terminalId === terminalId);
  if (!w) return false;
  const own = (w.data as Partial<TerminalWindowData>).autoResume;
  if (typeof own === 'boolean') return own;
  const frame = w.workspaceId ? board.frames.find((f) => f.workspaceId === w.workspaceId) : undefined;
  if (typeof frame?.autoResume === 'boolean') return frame.autoResume;
  return board.autoResume === true;
}

/** Settings › Agents › Resume prompt 没填时用的那段（设计画布 PluginResume 第 4 节）。 */
export const DEFAULT_RESUME_PROMPT =
  "Your usage limit has reset. Continue the task you were working on when the limit stopped you, from where you left off. Don't redo work that is already done.";

/** codex 看不到子 agent，续跑时总加这一句。 */
export const CODEX_SUBAGENT_LINE = "If any sub-agents you spawned didn't finish, check them and spawn them again.";

/** 跟着额度断掉的 claude 后台子 agent（逐个点名，让主 agent 用 SendMessage 按 id 接回）。 */
export function subagentSection(lost: readonly Pick<BackgroundAgent, 'id' | 'description' | 'agentType'>[]): string {
  const lines = lost.map((a) => `• ${a.description ?? a.agentType ?? 'Background agent'} (agent id ${a.id})`);
  return [
    'These background agents stopped at the usage limit before they finished:',
    ...lines,
    "Check what each one already did, then resume it with SendMessage to its id. If it can't be resumed, start it again.",
  ].join('\n');
}

export interface ResumePromptInput {
  agent: AgentKind;
  /** Settings 里的 Resume prompt；空的用 DEFAULT_RESUME_PROMPT。 */
  template?: string | null;
  /** setOwner 带的提示词（集群的带任务编号），有就代替模板。 */
  override?: string | null;
  /** claude 跟着断掉的后台子 agent。 */
  lost?: readonly Pick<BackgroundAgent, 'id' | 'description' | 'agentType'>[];
  /** claude 自己续完那一轮后补发：只发子 agent 那一段，不带第一句。 */
  subagentsOnly?: boolean;
}

/** 续跑时发的文字：模板 + claude 断掉的子 agent（逐个点名）/ codex 的一句。 */
export function resumePromptText(input: ResumePromptInput): string {
  const lost = input.lost ?? [];
  if (input.subagentsOnly) return subagentSection(lost);
  const base = input.override?.trim() || input.template?.trim() || DEFAULT_RESUME_PROMPT;
  const parts = [base];
  if (input.agent === 'claude' && lost.length > 0) parts.push(subagentSection(lost));
  if (input.agent === 'codex') parts.push(CODEX_SUBAGENT_LINE);
  return parts.join('\n\n');
}

/**
 * 跟着额度断掉的子 agent：failed（不是会话结束）、在主线撞上前 5 分钟之后结束的。
 * claude 只报 status（“Failed”这类），看不出是不是额度，所以按时间算（待用真的 claude 核对）。
 */
export function lostSubagents(agents: readonly BackgroundAgent[], hitAt: number): BackgroundAgent[] {
  return agents.filter((a) => {
    if (a.state !== 'failed' || a.reason === 'Session ended') return false;
    const ended = a.endedAt ? Date.parse(a.endedAt) : NaN;
    return Number.isNaN(ended) || ended >= hitAt - SUBAGENT_LOST_BEFORE_MS;
  });
}

/** 送进终端的按键：bracketed paste 一整段（多行不会中途提交），回车另外发。和 PL3 的 pasteKeys 一样。 */
export function pasteKeys(text: string): string {
  return `\u001b[200~${text}\u001b[201~`;
}
