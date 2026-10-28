// 本包内部对 AgentAdapter 的扩展，不过 IPC，不进 contracts。

import { AgentDeckError } from '@agentdeck/contracts';
import type { AgentAdapter, AgentCapabilities, CapabilityKey, LaunchContext, LaunchMode } from '@agentdeck/contracts';
import type { EnvSource } from '../env.ts';
import type { LaunchSkills } from '../skills/types.ts';
import { findExecutable, readHelp, readVersion } from '../env.ts';

export interface AdapterDeps {
  /** 登录 shell 的环境（apps/desktop 读出后传入）。 */
  env: EnvSource;
}

/**
 * 适配器 launch 实际拿到的上下文：contracts 的 LaunchContext 加本包自己的字段。
 * skills（N9）：这次要带的 skill 和库里的 MCP（SkillsServiceImpl.prepareLaunch 算好的）；没有就和以前一样。
 */
export interface AdapterLaunchContext extends LaunchContext {
  skills?: LaunchSkills;
  /**
   * AH3（IS-73）：只带会话参数（新建 / 接回 / fork 的 id 和第一条消息），不带钩子、MCP、skill、用户的额外参数。
   * 带全参数启动后 3 秒内因为“不认识的参数”退出时，AgentService 用它重开一次。
   */
  sessionOnly?: boolean;
}

/** AH3：适配器每次启动都可能带的一个参数（或子命令，写成 `command:<名字>`），以及它不在 `--help` 里时哪几项能力跟着不能用。 */
export interface LaunchFlag {
  flag: string;
  keys: CapabilityKey[];
}

export interface AgentAdapterExt extends AgentAdapter {
  /**
   * launch 是同步的。需要先做异步准备的适配器（codex 要先问它自己钩子的信任哈希）实现这个方法，
   * AgentService.start 在 launch 前调用。失败不抛，返回 hooks: false，launch 退回到没有钩子的做法。
   */
  prepare?(ctx: LaunchContext): Promise<{ hooks: boolean }>;
  /**
   * AH1：LaunchSpec.sendAfterReady 的 agent 还没到输入框时屏幕上会有的字（例如 kimi 的 “Trust this folder?”）。
   * AgentService 在终端安静下来时先看屏幕，有这些字就等下一次安静再打第一条消息。
   */
  readonly notReadyScreens?: readonly string[];
  /**
   * AH3（IS-74）：SessionStart 要等第一次输入才来（codex）。状态机从第一次输入开始等钩子，Check again 不做空启动。
   */
  readonly sessionStartOnFirstInput?: boolean;
  /** AH3：Check again 在 `--help` 里找的参数（按这次检测到的版本会带的那些）。 */
  launchFlags?(version: string | null): LaunchFlag[];
}

export type DetectResult = Awaited<ReturnType<AgentAdapter['detect']>>;

export async function detectCommand(command: string, deps: AdapterDeps, versionArgs?: string[]): Promise<DetectResult> {
  return (await detectWithHelp(command, deps, versionArgs)).result;
}

/**
 * 检测，读不出版本时再读一次 `--help`（AH3：版本未知时按 help 里有没有参数决定带不带，env.ts atLeast）。
 */
export async function detectWithHelp(
  command: string,
  deps: AdapterDeps,
  versionArgs?: string[],
): Promise<{ result: DetectResult; help: string | null }> {
  const env = deps.env();
  const path = await findExecutable(command, env);
  if (!path) return { result: { installed: false, version: null, path: null }, help: null };
  const version = await readVersion(path, env, versionArgs);
  const help = version === null ? await readHelp(path, env) : null;
  return { result: { installed: true, version, path }, help };
}

export const NO_CAPABILITIES: AgentCapabilities = { hooks: false, resume: false, fork: false, askTool: false };

export function unsupported(label: string, mode: LaunchMode): never {
  const what = mode.kind === 'fork' ? "can't fork a conversation" : "can't resume a conversation";
  throw new AgentDeckError({ code: 'unsupported', message: `${label} ${what}` });
}
