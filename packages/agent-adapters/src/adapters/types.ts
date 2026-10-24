// 本包内部对 AgentAdapter 的扩展，不过 IPC，不进 contracts。

import { AgentDeckError } from '@agentdeck/contracts';
import type { AgentAdapter, AgentCapabilities, LaunchContext, LaunchMode } from '@agentdeck/contracts';
import type { EnvSource } from '../env.ts';
import type { LaunchSkills } from '../skills/types.ts';
import { findExecutable, readVersion } from '../env.ts';

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
}

export interface AgentAdapterExt extends AgentAdapter {
  /**
   * launch 是同步的。需要先做异步准备的适配器（codex 要先问它自己钩子的信任哈希）实现这个方法，
   * AgentService.start 在 launch 前调用。失败不抛，返回 hooks: false，launch 退回到没有钩子的做法。
   */
  prepare?(ctx: LaunchContext): Promise<{ hooks: boolean }>;
}

export type DetectResult = Awaited<ReturnType<AgentAdapter['detect']>>;

export async function detectCommand(command: string, deps: AdapterDeps, versionArgs?: string[]): Promise<DetectResult> {
  const env = deps.env();
  const path = await findExecutable(command, env);
  if (!path) return { installed: false, version: null, path: null };
  return { installed: true, version: await readVersion(path, env, versionArgs), path };
}

export const NO_CAPABILITIES: AgentCapabilities = { hooks: false, resume: false, fork: false, askTool: false };

export function unsupported(label: string, mode: LaunchMode): never {
  const what = mode.kind === 'fork' ? "can't fork a conversation" : "can't resume a conversation";
  throw new AgentDeckError({ code: 'unsupported', message: `${label} ${what}` });
}
