// X6：恢复上次会话（DR-14、TC-14）。Stop all and quit、电脑重启、tmux 服务被结束之后，终端窗口还在白板上，进程没了。
//
// - 要不要恢复：窗口没有 terminalId，或者它不在 terminals.list() 里（tmux 会话还在就不恢复，照常接上）。
// - agent：记下了会话 id 就按它 resume（claude --resume <id>、codex resume <id>……，命令由各自的适配器拼）；
//   没记下（还没开始对话、或者这个 agent 不支持接回）就新开，并说明是新对话。
// - Shell：在原目录重开一个交互的 shell，把上次跑的命令（lastCommand，没有就用 startCommand）填进输入行但不运行。
//   自定义命令（agent 为 custom）也按 Shell 恢复：不直接再跑一遍，而是在 shell 里填好它。
// 窗口的位置和 id 不变，终端换新 id。整块白板的 Restore all 和窗口里的 Restore 都走这里。

import {
  isAgentDeckErrorData,
  type AgentDeckApi,
  type StartAgentRequest,
  type TerminalId,
  type TerminalWindowData,
  type WindowRestoreContext,
  type WindowRestoreItem,
  type WindowRestoreResult,
} from '@agentdeck/contracts';
import { termSizeFor } from './metrics.ts';
import { commandName } from './title.ts';

export interface TerminalRestorePlan extends WindowRestoreItem {
  /** 传给 agents.start 的（cwd、workspaceId、size 由调用方加）。 */
  request: Pick<StartAgentRequest, 'agent' | 'mode'> & { prefill?: string };
  /** 恢复后固定要改的 data（Shell 化的自定义命令要改 agent 和 startCommand）。terminalId、cmd、args、sessionId 按启动结果填。 */
  data: Partial<TerminalWindowData>;
}

/** 窗口的进程是不是没了。 */
export function needsRestore(d: Pick<TerminalWindowData, 'terminalId'>, live: ReadonlySet<TerminalId>): boolean {
  return d.terminalId === null || !live.has(d.terminalId);
}

export function isShellLike(d: Pick<TerminalWindowData, 'agent'>): boolean {
  return d.agent === 'shell' || d.agent === 'custom';
}

/** Shell 恢复时填进输入行的命令：上次跑的，没有就用启动时的；自定义命令就是它自己。去掉控制字符，空的为 null。 */
export function refillCommand(d: Pick<TerminalWindowData, 'agent' | 'cmd' | 'args' | 'startCommand' | 'lastCommand'>): string | null {
  const custom = d.agent === 'custom' ? [d.cmd, ...d.args].filter(Boolean).join(' ') : null;
  for (const c of [d.lastCommand, d.startCommand, custom]) {
    const t = oneLine(c);
    if (t) return t;
  }
  return null;
}

/** 这个窗口按 Restore 会怎样。 */
export function planRestore(d: TerminalWindowData): TerminalRestorePlan {
  if (isShellLike(d)) {
    const refill = refillCommand(d);
    // 自定义命令变成 Shell：标题栏用 shell 的名字，Restart 时照旧跑那条命令（startCommand）
    const data: Partial<TerminalWindowData> = d.agent === 'custom' ? { agent: 'shell', startCommand: refill } : {};
    const label = d.agent === 'custom' ? 'shell' : commandName(d);
    return {
      kind: 'shell',
      label,
      detail: refill ? `Opens ${label} here with “${refill}” typed in, not run` : `Opens ${label} in the same folder`,
      fresh: false,
      request: { agent: 'shell', mode: { kind: 'new' }, ...(refill ? { prefill: refill } : {}) },
      data,
    };
  }
  const label = commandName(d);
  if (d.sessionId) {
    return {
      kind: 'agent',
      label,
      detail: 'Resumes the conversation',
      fresh: false,
      request: { agent: d.agent, mode: { kind: 'resume', sessionId: d.sessionId } },
      data: {},
    };
  }
  return {
    kind: 'agent',
    label,
    detail: 'No saved conversation; starts a new one',
    fresh: true,
    request: { agent: d.agent, mode: { kind: 'new' } },
    data: {},
  };
}

/** Restore 和 Restart 不一样时才单独给 Restore 按钮（有会话可接、有命令可填、自定义命令）。 */
export function restoreDiffersFromRestart(d: TerminalWindowData): boolean {
  if (d.agent === 'custom') return true;
  if (d.agent === 'shell') return refillCommand(d) !== null;
  return d.sessionId !== null;
}

/**
 * 按计划重开。记下的会话接不回（这个 agent 不支持 resume）时退回新对话，fresh 为 true。
 * 失败时抛 AgentDeckError（例如 command-not-found、目录不在了）。
 */
export async function restoreTerminal(
  api: Pick<AgentDeckApi, 'agents'>,
  d: TerminalWindowData,
  ctx: WindowRestoreContext,
): Promise<WindowRestoreResult<TerminalWindowData>> {
  const plan = planRestore(d);
  const base = { cwd: d.cwd, workspaceId: ctx.workspaceId, size: termSizeFor(ctx.contentSize) };
  let fresh = plan.fresh;
  let res;
  try {
    res = await api.agents.start({ ...base, ...plan.request });
  } catch (e) {
    if (plan.request.mode.kind !== 'resume' || !isAgentDeckErrorData(e) || e.code !== 'unsupported') throw e;
    fresh = true;
    res = await api.agents.start({ ...base, ...plan.request, mode: { kind: 'new' } });
  }
  return {
    patch: {
      ...plan.data,
      terminalId: res.terminalId,
      cmd: res.cmd,
      args: res.args,
      sessionId: res.sessionId ?? (fresh ? null : d.sessionId),
    },
    fresh,
  };
}

function oneLine(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t || null;
}
