// 额度上限（插件 Auto-resume · PL5）的组装：把 agent-adapters 的 LimitServiceImpl 接到终端（sendKeys）、用量、后台子 agent、
// 白板（Auto-resume 开关、Prompt queue）、设置（Resume prompt）和“不让 Mac 睡”上。规则都在 agent-adapters/src/limits，这里只接线。
//
// 环境变量（测试用）：AGENTDECK_RESUME_STAGGER_MS（同一账号几个终端续跑的间隔，默认 30 秒）、
//                    AGENTDECK_LIMIT_GRACE_MS（恢复时间后再等多久，默认 1 分钟）。

import type { AgentInfo, AgentKind, BoardState, LimitEvent, LimitService, TerminalId } from '@agentdeck/contracts';
import { claudeSelfResumes, limitConfigDir, LimitServiceImpl, type LimitServiceOptions, type LimitTarget } from '@agentdeck/agent-adapters';

/** 读环境里的测试用时长。不是非负整数的忽略。 */
export function limitTimingFromEnv(env: Readonly<Record<string, string | undefined>>): { staggerMs?: number; graceMs?: number } {
  const ms = (v: string | undefined): number | undefined => (v !== undefined && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);
  const staggerMs = ms(env['AGENTDECK_RESUME_STAGGER_MS']);
  const graceMs = ms(env['AGENTDECK_LIMIT_GRACE_MS']);
  return { ...(staggerMs !== undefined ? { staggerMs } : {}), ...(graceMs !== undefined ? { graceMs } : {}) };
}

/**
 * 不让 Mac 睡的几个来源（PL3 的 Prompt queue 从界面调 app.setKeepAwake，PL5 的 LimitService 在主进程里）：
 * 任何一个要就开，都不要了才关。start / stop 是 powerSaveBlocker 的包装。
 */
export function createKeepAwake(blocker: { start: () => number; stop: (id: number) => void }) {
  const wanted = new Set<string>();
  let id: number | null = null;
  return (reason: string, on: boolean): void => {
    if (on) wanted.add(reason);
    else wanted.delete(reason);
    if (wanted.size > 0 && id === null) id = blocker.start();
    else if (wanted.size === 0 && id !== null) {
      blocker.stop(id);
      id = null;
    }
  };
}

export interface LimitsDeps {
  emit: (event: LimitEvent) => void;
  /** 状态机里的 agent（终端接回之前用库里的记录）。 */
  agentOf: (terminalId: TerminalId) => AgentKind | null;
  /** 库里所有终端的 id。 */
  terminalIds: () => TerminalId[];
  /** agents.list()：claude 的版本（2.1.234 起自己续跑）。 */
  agents: () => Promise<AgentInfo[]>;
  loginEnv: () => Readonly<Record<string, string | undefined>>;
  homeDir: string;
  sendKeys: LimitServiceOptions['sendKeys'];
  setKeepAwake: (on: boolean) => void;
  usage: LimitServiceOptions['usage'];
  subagents: NonNullable<LimitServiceOptions['subagents']>;
  board: () => Promise<BoardState>;
  resumePrompt: () => string | null | undefined;
  env: Readonly<Record<string, string | undefined>>;
}

/** 建好 LimitService 并开始定时检查。返回的对象注册成 'limits'，事件照 LimitServiceImpl 的 note* 接。 */
export function createLimits(deps: LimitsDeps): LimitServiceImpl {
  let claudeVersion: string | null = null;
  const refreshVersion = () =>
    deps.agents().then(
      (list) => {
        claudeVersion = list.find((a) => a.id === 'claude')?.version ?? null;
      },
      () => undefined,
    );
  void refreshVersion();
  // claude 升级后不重启应用也能认到（半小时一次）
  const versionTimer = setInterval(() => void refreshVersion(), 30 * 60_000);
  versionTimer.unref();

  const lookup = (terminalId: TerminalId): LimitTarget | null => {
    const agent = deps.agentOf(terminalId);
    if (!agent) return null;
    return {
      terminalId,
      agent,
      configDir: limitConfigDir(agent, deps.loginEnv(), deps.homeDir),
      selfResumes: agent === 'claude' && claudeSelfResumes(claudeVersion),
    };
  };
  const limits = new LimitServiceImpl({
    emit: deps.emit,
    lookup,
    targets: () => deps.terminalIds().flatMap((id) => lookup(id) ?? []),
    sendKeys: deps.sendKeys,
    setKeepAwake: deps.setKeepAwake,
    usage: deps.usage,
    subagents: deps.subagents,
    board: deps.board,
    resumePrompt: deps.resumePrompt,
    ...limitTimingFromEnv(deps.env),
    log: (m) => console.warn(`[agentdeck] ${m}`),
  });
  const close = limits.close.bind(limits);
  limits.close = () => {
    clearInterval(versionTimer);
    close();
  };
  limits.start();
  return limits;
}

/** 注册给界面的只有 contracts 里的五个方法（note*、tick、close 不经 IPC 开放）。 */
export function limitsApi(impl: LimitService): LimitService {
  return {
    list: () => impl.list(),
    resumeNow: (account, terminalIds) => impl.resumeNow(account, terminalIds),
    skip: (terminalId) => impl.skip(terminalId),
    cancel: (account) => impl.cancel(account),
    setOwner: (terminalId, owner, prompt) => impl.setOwner(terminalId, owner, prompt),
  };
}
